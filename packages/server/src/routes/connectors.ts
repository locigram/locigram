import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { connectorInstances, connectorSyncs } from '@locigram/db'
import { eq, and, desc } from 'drizzle-orm'
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

  const [deleted] = await db.delete(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .returning({ id: connectorInstances.id })

  if (!deleted) return c.json({ error: 'not found' }, 404)
  return c.json({ id: deleted.id, status: 'deleted' })
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

  return {
    itemsPulled:  memories.length,
    itemsPushed:  result.stored ?? memories.length,
    itemsSkipped: result.skipped ?? 0,
    cursor:       newCursor,
  }
}
