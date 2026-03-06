import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { connectorInstances, connectorSyncs } from '@locigram/db'
import { eq, and, desc } from 'drizzle-orm'

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

// List all connector instances for this palace
connectorsRoute.get('/', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')

  const rows = await db.select().from(connectorInstances)
    .where(eq(connectorInstances.palaceId, palace.id))
    .orderBy(desc(connectorInstances.createdAt))

  return c.json({ connectors: rows, total: rows.length })
})

// Create a new connector instance
connectorsRoute.post('/', zValidator('json', createSchema), async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const body = c.req.valid('json')

  const [instance] = await db.insert(connectorInstances).values({
    palaceId:      palace.id,
    connectorType: body.connectorType,
    name:          body.name,
    config:        body.config,
    schedule:      body.schedule ?? null,
  }).returning()

  return c.json(instance, 201)
})

// Get connector instance details + recent syncs
connectorsRoute.get('/:id', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const id = c.req.param('id')

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

// Update connector instance
connectorsRoute.patch('/:id', zValidator('json', updateSchema), async (c) => {
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

// Delete connector instance
connectorsRoute.delete('/:id', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const id = c.req.param('id')

  const [deleted] = await db.delete(connectorInstances)
    .where(and(eq(connectorInstances.id, id), eq(connectorInstances.palaceId, palace.id)))
    .returning({ id: connectorInstances.id })

  if (!deleted) return c.json({ error: 'not found' }, 404)
  return c.json({ id: deleted.id, status: 'deleted' })
})

// Trigger manual sync
connectorsRoute.post('/:id/sync', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const id = c.req.param('id')

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

  // TODO: Phase 2 — actually invoke the connector's pull() here
  // For now, record the sync attempt so the API contract is established

  const startTime = Date.now()

  // Mark sync completed (placeholder — real sync logic in Phase 2)
  const [completedSync] = await db.update(connectorSyncs)
    .set({
      status:      'completed',
      completedAt: new Date(),
      durationMs:  Date.now() - startTime,
    })
    .where(eq(connectorSyncs.id, sync.id))
    .returning()

  // Update instance last_sync_at
  await db.update(connectorInstances)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(connectorInstances.id, id))

  return c.json(completedSync)
})

// List sync history
connectorsRoute.get('/:id/syncs', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const id = c.req.param('id')
  const limit = parseInt(c.req.query('limit') ?? '20')

  // Verify instance belongs to this palace
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
