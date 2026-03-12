import { Hono } from 'hono'
import { WebhookPayloadSchema, toRawMemory, pushToBuffer } from './plugin'
import type { WebhookConnectorConfig, SingleMemory } from './plugin'

/**
 * First-class webhook ingestion routes.
 *
 * POST /api/webhook/ingest   → immediate pipeline ingestion (recommended)
 * POST /api/webhook/push     → queue for next scheduled pipeline run
 * POST /api/webhook/health   → convenience alias for health data (sets locus + sourceType)
 * POST /api/webhook/location → convenience alias for location data
 * POST /api/webhook/browsing → convenience alias for browser history
 *
 * All routes accept single memory or batch { memories: [...], defaults: {...} }
 *
 * Auth: x-webhook-secret header OR x-api-key header (if apiKeys configured)
 */
export function buildWebhookRoute(connectorConfig: WebhookConnectorConfig = {}) {
  const route = new Hono()

  // ── Auth middleware ──────────────────────────────────────────────────────
  route.use('*', async (c, next) => {
    const secret = c.req.header('x-webhook-secret')
    const apiKey = c.req.header('x-api-key')

    if (connectorConfig.secret || connectorConfig.apiKeys?.length) {
      const validSecret = connectorConfig.secret && secret === connectorConfig.secret
      const validKey = connectorConfig.apiKeys?.includes(apiKey ?? '')
      if (!validSecret && !validKey) {
        return c.json({ error: 'Unauthorized' }, 401)
      }
    }
    await next()
  })

  // ── Helper: parse + normalize payload ───────────────────────────────────
  function parsePayload(body: unknown, overrides?: Partial<SingleMemory>): {
    items: SingleMemory[]
    defaults?: { sourceType?: string; locus?: string; connector?: string; metadata?: Record<string, unknown> }
  } {
    const parsed = WebhookPayloadSchema.parse(body)

    if ('memories' in parsed) {
      // Batch mode
      const items = parsed.memories.map(m => ({ ...m, ...overrides }))
      const defaults = parsed.defaults as any
      return { items, defaults }
    }

    // Single mode
    return { items: [{ ...parsed, ...overrides } as SingleMemory] }
  }

  // ── POST /ingest — immediate pipeline ingestion ─────────────────────────
  route.post('/ingest', async (c) => {
    try {
      const body = await c.req.json()
      const palace = c.get('palace')
      const db = c.get('db')
      const pipelineConfig = c.get('pipelineConfig')
      const { items, defaults } = parsePayload(body)

      const rawMemories = items.map(item => toRawMemory(item, palace.id, defaults))

      const { ingest } = await import('@locigram/pipeline')
      const result = await ingest(rawMemories, db, pipelineConfig)

      return c.json({
        ok: true,
        ingested: rawMemories.length,
        ...result,
      })
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return c.json({ error: 'Invalid payload', details: err.errors }, 400)
      }
      console.error('[webhook/ingest]', err)
      return c.json({ error: err.message }, 500)
    }
  })

  // ── POST /push — queue for scheduled pipeline run ───────────────────────
  route.post('/push', async (c) => {
    try {
      const body = await c.req.json()
      const palace = c.get('palace')
      const { items, defaults } = parsePayload(body)

      const rawMemories = items.map(item => toRawMemory(item, palace.id, defaults))
      for (const raw of rawMemories) pushToBuffer(raw)

      return c.json({ ok: true, queued: rawMemories.length })
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return c.json({ error: 'Invalid payload', details: err.errors }, 400)
      }
      return c.json({ error: err.message }, 500)
    }
  })

  // ── Convenience aliases for common data types ───────────────────────────

  // POST /health — Apple Health, Fitbit, etc.
  route.post('/health', async (c) => {
    try {
      const body = await c.req.json()
      const palace = c.get('palace')
      const db = c.get('db')
      const pipelineConfig = c.get('pipelineConfig')

      const { items, defaults } = parsePayload(body, {
        sourceType: 'health',
        locus: 'personal/health',
        connector: 'health',
      })

      const rawMemories = items.map(item => toRawMemory(item, palace.id, {
        ...defaults,
        sourceType: 'health',
        locus: 'personal/health',
        connector: 'health',
      }))

      const { ingest } = await import('@locigram/pipeline')
      const result = await ingest(rawMemories, db, pipelineConfig)

      return c.json({ ok: true, ingested: rawMemories.length, ...result })
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return c.json({ error: 'Invalid payload', details: err.errors }, 400)
      }
      console.error('[webhook/health]', err)
      return c.json({ error: err.message }, 500)
    }
  })

  // POST /location — GPS, geofence, check-ins
  route.post('/location', async (c) => {
    try {
      const body = await c.req.json()
      const palace = c.get('palace')
      const db = c.get('db')
      const pipelineConfig = c.get('pipelineConfig')

      const { items, defaults } = parsePayload(body, {
        sourceType: 'location' as any,
        locus: 'personal/location',
        connector: 'location',
      })

      const rawMemories = items.map(item => toRawMemory(item, palace.id, {
        ...defaults,
        sourceType: 'location',
        locus: 'personal/location',
        connector: 'location',
      }))

      const { ingest } = await import('@locigram/pipeline')
      const result = await ingest(rawMemories, db, pipelineConfig)

      return c.json({ ok: true, ingested: rawMemories.length, ...result })
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return c.json({ error: 'Invalid payload', details: err.errors }, 400)
      }
      console.error('[webhook/location]', err)
      return c.json({ error: err.message }, 500)
    }
  })

  // POST /browsing — browser history, bookmarks
  route.post('/browsing', async (c) => {
    try {
      const body = await c.req.json()
      const palace = c.get('palace')
      const db = c.get('db')
      const pipelineConfig = c.get('pipelineConfig')

      const { items, defaults } = parsePayload(body, {
        sourceType: 'browsing' as any,
        locus: 'personal/browsing',
        connector: 'browsing',
      })

      const rawMemories = items.map(item => toRawMemory(item, palace.id, {
        ...defaults,
        sourceType: 'browsing',
        locus: 'personal/browsing',
        connector: 'browsing',
      }))

      const { ingest } = await import('@locigram/pipeline')
      const result = await ingest(rawMemories, db, pipelineConfig)

      return c.json({ ok: true, ingested: rawMemories.length, ...result })
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return c.json({ error: 'Invalid payload', details: err.errors }, 400)
      }
      console.error('[webhook/browsing]', err)
      return c.json({ error: err.message }, 500)
    }
  })

  return route
}
