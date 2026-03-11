import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { connectorInstances, connectorSyncs, locigrams } from '@locigram/db'
import { eq, and, desc, inArray } from 'drizzle-orm'
import crypto from 'node:crypto'
import type { ConnectorPlugin, PullResult, RawMemory } from '@locigram/core'
import { registry } from '@locigram/registry'

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function generateConnectorToken(): { raw: string; hash: string } {
  const raw = 'lc_' + crypto.randomBytes(32).toString('hex')
  return { raw, hash: hashToken(raw) }
}

/** Reject connector tokens — admin-only guard */
function requirePalaceToken(c: any): Response | null {
  if (c.get('isConnectorToken')) {
    return c.json({ error: 'connector tokens cannot access this endpoint' }, 403)
  }
  return null
}

/** For instance-scoped endpoints: allow if palace token OR matching connector token */
function requireInstanceAccess(c: any, instanceId: string): Response | null {
  if (c.get('isConnectorToken') && c.get('connectorInstanceId') !== instanceId) {
    return c.json({ error: 'token not valid for this connector instance' }, 403)
  }
  return null
}

const createSchema = z.object({
  connectorType: z.string().min(1),
  name:          z.string().min(1),
  distribution:  z.enum(['bundled', 'external']).default('external'),
  config:        z.record(z.string(), z.unknown()).default({}),
  schedule:      z.string().nullable().optional(),
})

const updateSchema = z.object({
  name:     z.string().min(1).optional(),
  config:   z.record(z.string(), z.unknown()).optional(),
  schedule: z.string().nullable().optional(),
  status:   z.enum(['active', 'paused', 'disabled']).optional(),
})

export const connectorsRoute = new Hono()

// List all connector instances for this palace (admin only)
connectorsRoute.get('/', async (c) => {
  const denied = requirePalaceToken(c)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')

  const rows = await db.select().from(connectorInstances)
    .where(eq(connectorInstances.palaceId, palace.id))
    .orderBy(desc(connectorInstances.createdAt))

  return c.json({ connectors: rows, total: rows.length })
})

// Create a new connector instance (admin only)
connectorsRoute.post('/', zValidator('json', createSchema), async (c) => {
  const denied = requirePalaceToken(c)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')
  const body = c.req.valid('json')

  const { raw, hash } = generateConnectorToken()

  const [instance] = await db.insert(connectorInstances).values({
    palaceId:      palace.id,
    connectorType: body.connectorType,
    name:          body.name,
    distribution:  body.distribution,
    config:        body.config,
    schedule:      body.schedule ?? null,
    tokenHash:     hash,
  }).returning()

  return c.json({ ...instance, token: raw }, 201)
})

// Get connector instance details + recent syncs (admin or matching connector token)
connectorsRoute.get('/:id', async (c) => {
  const id = c.req.param('id')
  const denied = requireInstanceAccess(c, id)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')

  const [instance] = await db.select().from(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .limit(1)

  if (!instance) return c.json({ error: 'not found' }, 404)

  const recentSyncs = await db.select().from(connectorSyncs)
    .where(eq(connectorSyncs.instanceId, id))
    .orderBy(desc(connectorSyncs.startedAt))
    .limit(10)

  return c.json({ ...instance, recentSyncs })
})

// Update connector instance (admin only)
connectorsRoute.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const denied = requirePalaceToken(c)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const [updated] = await db.update(connectorInstances)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .returning()

  if (!updated) return c.json({ error: 'not found' }, 404)
  return c.json(updated)
})

// Delete connector instance (admin only)
connectorsRoute.delete('/:id', async (c) => {
  const denied = requirePalaceToken(c)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')
  const id = c.req.param('id')
  const dataAction = c.req.query('data') ?? 'keep'

  if (dataAction === 'delete') {
    await db.delete(locigrams).where(eq(locigrams.connectorInstanceId, id))
  } else if (dataAction === 'expire') {
    await db.update(locigrams)
      .set({ expiresAt: new Date() })
      .where(eq(locigrams.connectorInstanceId, id))
  }

  const [deleted] = await db.delete(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .returning({ id: connectorInstances.id })

  if (!deleted) return c.json({ error: 'not found' }, 404)
  return c.json({ id: deleted.id, status: 'deleted', dataAction })
})

// Trigger manual sync (admin or matching connector token)
connectorsRoute.post('/:id/sync', async (c) => {
  const id = c.req.param('id')
  const denied = requireInstanceAccess(c, id)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')
  const pipelineConfig = c.get('pipelineConfig')

  const [instance] = await db.select().from(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .limit(1)

  if (!instance) return c.json({ error: 'not found' }, 404)
  if (instance.status === 'disabled') return c.json({ error: 'connector is disabled' }, 400)
  if (instance.distribution === 'external') {
    return c.json({ error: 'external connectors should use POST /api/connectors/:id/report to report sync results and POST /api/connectors/:id/ingest to push memories' }, 400)
  }

  // Create sync record
  const [sync] = await db.insert(connectorSyncs).values({
    instanceId:   id,
    cursorBefore: instance.cursor,
  }).returning()

  const startTime = Date.now()

  try {
    const result = await executeSync(db, instance, palace.id, pipelineConfig)

    const [completedSync] = await db.update(connectorSyncs)
      .set({
        status:       'completed',
        completedAt:  new Date(),
        itemsPulled:  result.itemsPulled,
        itemsPushed:  result.itemsPushed,
        itemsSkipped: result.itemsSkipped,
        cursorAfter:  result.cursor ?? null,
        durationMs:   Date.now() - startTime,
      })
      .where(eq(connectorSyncs.id, sync.id))
      .returning()

    // Update instance
    await db.update(connectorInstances)
      .set({
        lastSyncAt: new Date(),
        cursor:     result.cursor ?? instance.cursor,
        itemsSynced: (instance.itemsSynced ?? 0) + result.itemsPushed,
        lastError:  null,
        updatedAt:  new Date(),
      })
      .where(eq(connectorInstances.id, id))

    return c.json(completedSync)
  } catch (err: any) {
    await db.update(connectorSyncs)
      .set({
        status:      'failed',
        completedAt: new Date(),
        error:       err.message,
        durationMs:  Date.now() - startTime,
      })
      .where(eq(connectorSyncs.id, sync.id))

    await db.update(connectorInstances)
      .set({ lastError: err.message, updatedAt: new Date() })
      .where(eq(connectorInstances.id, id))

    return c.json({ error: 'sync failed', detail: err.message }, 500)
  }
})

// Report sync results from external connectors
const reportSchema = z.object({
  itemsPulled:  z.number().int().min(0).default(0),
  itemsPushed:  z.number().int().min(0).default(0),
  itemsSkipped: z.number().int().min(0).default(0),
  cursorAfter:  z.unknown().optional(),
  error:        z.string().optional(),
  durationMs:   z.number().int().optional(),
})

connectorsRoute.post('/:id/report', zValidator('json', reportSchema), async (c) => {
  const id = c.req.param('id')
  const denied = requireInstanceAccess(c, id)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')
  const body = c.req.valid('json')

  const [instance] = await db.select().from(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .limit(1)

  if (!instance) return c.json({ error: 'not found' }, 404)

  const syncStatus = body.error ? 'failed' : 'completed'

  const [sync] = await db.insert(connectorSyncs).values({
    instanceId:   id,
    status:       syncStatus,
    completedAt:  new Date(),
    itemsPulled:  body.itemsPulled,
    itemsPushed:  body.itemsPushed,
    itemsSkipped: body.itemsSkipped,
    cursorBefore: instance.cursor,
    cursorAfter:  body.cursorAfter ?? null,
    error:        body.error ?? null,
    durationMs:   body.durationMs ?? null,
  }).returning()

  await db.update(connectorInstances)
    .set({
      lastSyncAt:  new Date(),
      cursor:      body.cursorAfter ?? instance.cursor,
      itemsSynced: (instance.itemsSynced ?? 0) + body.itemsPushed,
      lastError:   body.error ?? null,
      updatedAt:   new Date(),
    })
    .where(eq(connectorInstances.id, id))

  return c.json(sync)
})

// Ingest memories from external connectors
const ingestSchema = z.object({
  memories: z.array(z.object({
    content:     z.string().min(1),
    sourceType:  z.string().min(1),
    sourceRef:   z.string().optional(),
    occurredAt:  z.string().optional(),
    locus:       z.string().optional(),
    importance:  z.enum(['low', 'normal', 'high']).optional(),
    metadata:    z.record(z.string(), z.unknown()).optional(),
    // Structured fields (Phase 2.6) — pass through to pipeline
    category:         z.enum(['decision', 'preference', 'fact', 'lesson', 'entity', 'observation', 'convention', 'checkpoint']).optional(),
    subject:          z.string().optional(),
    predicate:        z.string().optional(),
    object_val:       z.string().optional(),
    durability_class: z.enum(['permanent', 'stable', 'active', 'session', 'checkpoint']).optional(),
  })).min(1).max(100),
})

connectorsRoute.post('/:id/ingest', zValidator('json', ingestSchema), async (c) => {
  const id = c.req.param('id')
  const denied = requireInstanceAccess(c, id)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')
  const pipelineConfig = c.get('pipelineConfig')
  const body = c.req.valid('json')

  const [instance] = await db.select().from(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .limit(1)

  if (!instance) return c.json({ error: 'not found' }, 404)
  if (instance.status === 'disabled') return c.json({ error: 'connector is disabled' }, 400)

  // Transform to RawMemory[] with enforced lineage
  const memories = body.memories.map(m => ({
    content:     m.content,
    sourceType:  m.sourceType,
    sourceRef:   m.sourceRef,
    occurredAt:  m.occurredAt ? new Date(m.occurredAt) : new Date(),
    locus:       m.locus ?? `connectors/${instance.connectorType}`,
    metadata: {
      ...m.metadata,
      connector: instance.connectorType,
      connector_instance_id: instance.id,
      ...(m.importance ? { importance: m.importance } : {}),
    },
    // Pass structured fields through if connector provides them
    ...(m.subject || m.predicate || m.object_val || m.durability_class || m.category ? {
      preClassified: {
        locus:           m.locus ?? `connectors/${instance.connectorType}`,
        entities:        [],
        confidence:      1.0,
        category:        m.category ?? undefined,
        subject:         m.subject ?? undefined,
        predicate:       m.predicate ?? undefined,
        objectVal:       m.object_val ?? undefined,
        durabilityClass: m.durability_class ?? undefined,
      },
    } : {}),
  }))

  const { ingest } = await import('@locigram/pipeline')
  const result = await ingest(memories, db, { ...pipelineConfig, palaceId: palace.id })

  // Tag the ingested locigrams with connector_instance_id
  if (result.ids && result.ids.length > 0) {
    await db.update(locigrams)
      .set({ connectorInstanceId: instance.id })
      .where(inArray(locigrams.id, result.ids))
  }

  return c.json({
    ingested: result.stored ?? body.memories.length,
    skipped:  result.skipped ?? 0,
  })
})

// List sync history (admin or matching connector token)
connectorsRoute.get('/:id/syncs', async (c) => {
  const id = c.req.param('id')
  const denied = requireInstanceAccess(c, id)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')
  const limit = parseInt(c.req.query('limit') ?? '20')

  const [instance] = await db.select({ id: connectorInstances.id }).from(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .limit(1)

  if (!instance) return c.json({ error: 'not found' }, 404)

  const syncs = await db.select().from(connectorSyncs)
    .where(eq(connectorSyncs.instanceId, id))
    .orderBy(desc(connectorSyncs.startedAt))
    .limit(limit)

  return c.json({ syncs, total: syncs.length })
})

// Rotate token (admin only)
connectorsRoute.post('/:id/token/rotate', async (c) => {
  const denied = requirePalaceToken(c)
  if (denied) return denied

  const db = c.get('db')
  const palace = c.get('palace')
  const id = c.req.param('id')

  const { raw, hash } = generateConnectorToken()

  const [updated] = await db.update(connectorInstances)
    .set({ tokenHash: hash, updatedAt: new Date() })
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .returning()

  if (!updated) return c.json({ error: 'not found' }, 404)
  return c.json({ id: updated.id, token: raw })
})

// ── Sync execution logic ─────────────────────────────────────────────────────

interface SyncResult {
  itemsPulled:  number
  itemsPushed:  number
  itemsSkipped: number
  cursor?:      unknown
}

export async function executeSync(
  db: any,
  instance: any,
  palaceId: string,
  pipelineConfig: any,
): Promise<SyncResult> {
  // Look up the connector plugin in the registry
  const plugins = registry.list()
  const pluginName = plugins.find(p => p === instance.connectorType)

  if (!pluginName) {
    throw new Error(`unknown connector type: ${instance.connectorType} (registered: ${plugins.join(', ')})`)
  }

  // Create a connector instance from the plugin
  const configs = [{ plugin: pluginName, config: instance.config }]
  const [connector] = registry.load(configs)

  // Call pull() with the stored cursor
  const cursorStr = instance.cursor && typeof instance.cursor === 'object' && 'value' in instance.cursor
    ? (instance.cursor as any).value
    : typeof instance.cursor === 'string' ? instance.cursor : undefined

  const pullResult = await connector.pull({ cursor: cursorStr })

  // Normalize result
  let memories: RawMemory[]
  let newCursor: unknown | undefined
  if (Array.isArray(pullResult)) {
    memories = pullResult
  } else {
    memories = (pullResult as PullResult).memories
    newCursor = (pullResult as PullResult).cursor
  }

  if (memories.length === 0) {
    return { itemsPulled: 0, itemsPushed: 0, itemsSkipped: 0, cursor: newCursor }
  }

  // Tag memories with connector info
  for (const mem of memories) {
    mem.metadata = {
      ...mem.metadata,
      connector: instance.connectorType,
      connector_instance_id: instance.id,
    }
  }

  // Push through the pipeline
  const { ingest } = await import('@locigram/pipeline')
  const result = await ingest(memories, db, { ...pipelineConfig, palaceId })

  // Tag ingested locigrams with connector_instance_id
  if (result.ids && result.ids.length > 0) {
    await db.update(locigrams)
      .set({ connectorInstanceId: instance.id })
      .where(inArray(locigrams.id, result.ids))
  }

  return {
    itemsPulled:  memories.length,
    itemsPushed:  result.stored ?? memories.length,
    itemsSkipped: result.skipped ?? 0,
    cursor:       newCursor,
  }
}
