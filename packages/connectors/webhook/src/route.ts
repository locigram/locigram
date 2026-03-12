import { Hono } from 'hono'
import { WebhookPayloadSchema, toRawMemory, pushToBuffer } from './plugin'
import type { WebhookConnectorConfig, SingleMemory } from './plugin'
import type { RawMemory } from '@locigram/core'

/**
 * First-class webhook ingestion routes.
 *
 * POST /api/webhook/ingest   → immediate pipeline ingestion (recommended)
 * POST /api/webhook/push     → queue for next scheduled pipeline run
 * POST /api/webhook/health   → convenience alias for health data (locus: personal/health)
 * POST /api/webhook/location → convenience alias for location data
 * POST /api/webhook/browsing → convenience alias for browser history
 *
 * All routes accept single memory or batch { memories: [...], defaults: {...} }
 *
 * Auth: x-webhook-secret header OR x-api-key header (if apiKeys configured)
 * Pipeline: noise filter → GLiNER NER → LLM extraction (if not preClassified) →
 *           entity resolution → mention storage → Postgres → embed worker → graph worker
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
      // Batch mode — apply overrides to each item
      const items = parsed.memories.map(m => ({ ...m, ...overrides }))
      const defaults = parsed.defaults as any
      return { items, defaults }
    }

    // Single mode
    return { items: [{ ...parsed, ...overrides } as SingleMemory] }
  }

  // ── Core: build RawMemory[] from request + run pipeline ─────────────────
  async function ingestFromRequest(
    c: any,
    body: unknown,
    overrides?: Partial<SingleMemory>,
    defaultOverrides?: { sourceType?: string; locus?: string; connector?: string },
  ) {
    const palace = c.get('palace')
    const db = c.get('db')
    const pipelineConfig = c.get('pipelineConfig')

    const { items, defaults } = parsePayload(body, overrides)

    // Merge default overrides (from typed endpoints) with batch defaults
    const mergedDefaults = {
      ...defaults,
      ...defaultOverrides,
    }

    const rawMemories: RawMemory[] = items.map(item => {
      const raw = toRawMemory(item, palace.id, mergedDefaults)

      // Auto-generate sourceRef for dedup if not provided
      // Uses content hash + date to prevent duplicate ingestion
      if (!raw.sourceRef && item.sourceType) {
        const date = (raw.occurredAt ?? new Date()).toISOString().split('T')[0]
        const hash = simpleHash(raw.content)
        raw.sourceRef = `webhook:${item.sourceType ?? 'generic'}:${date}:${hash}`
      }

      return raw
    })

    const { ingest } = await import('@locigram/pipeline')
    const result = await ingest(rawMemories, db, pipelineConfig)

    return {
      ok: true,
      ingested: rawMemories.length,
      ...result,
    }
  }

  // ── POST /ingest — immediate pipeline ingestion ─────────────────────────
  route.post('/ingest', async (c) => {
    try {
      const body = await c.req.json()
      return c.json(await ingestFromRequest(c, body))
    } catch (err: any) {
      return handleError(c, err, 'webhook/ingest')
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
      return handleError(c, err, 'webhook/push')
    }
  })

  // ── Typed convenience endpoints ─────────────────────────────────────────
  // Each auto-sets locus, sourceType, and connector name so callers don't need to.

  // POST /health — Apple Health, Fitbit, wearables
  route.post('/health', async (c) => {
    try {
      const body = await c.req.json()
      return c.json(await ingestFromRequest(c, body,
        { sourceType: 'health', connector: 'health' },
        { sourceType: 'health', locus: 'personal/health', connector: 'health' },
      ))
    } catch (err: any) {
      return handleError(c, err, 'webhook/health')
    }
  })

  // POST /location — GPS coordinates, geofence, check-ins
  route.post('/location', async (c) => {
    try {
      const body = await c.req.json()
      return c.json(await ingestFromRequest(c, body,
        { sourceType: 'location' as any, connector: 'location' },
        { sourceType: 'location', locus: 'personal/location', connector: 'location' },
      ))
    } catch (err: any) {
      return handleError(c, err, 'webhook/location')
    }
  })

  // POST /browsing — browser history, bookmarks
  route.post('/browsing', async (c) => {
    try {
      const body = await c.req.json()
      return c.json(await ingestFromRequest(c, body,
        { sourceType: 'browsing' as any, connector: 'browsing' },
        { sourceType: 'browsing', locus: 'personal/browsing', connector: 'browsing' },
      ))
    } catch (err: any) {
      return handleError(c, err, 'webhook/browsing')
    }
  })

  return route
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Simple non-crypto hash for sourceRef dedup — fast, collision-resistant enough */
function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

/** Consistent error handling */
function handleError(c: any, err: any, tag: string) {
  if (err.name === 'ZodError') {
    return c.json({ error: 'Invalid payload', details: err.errors }, 400)
  }
  console.error(`[${tag}]`, err)
  return c.json({ error: err.message }, 500)
}
