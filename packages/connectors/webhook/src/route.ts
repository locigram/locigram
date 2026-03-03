import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { WebhookPayloadSchema, pushToBuffer } from './plugin'
import type { WebhookConnectorConfig } from './plugin'
import type { RawMemory } from '@locigram/core'

/**
 * Mount this on the Hono app to enable inbound webhook memory capture.
 * POST /api/webhook/push   → queues memory for pipeline ingestion
 * POST /api/webhook/ingest → push + immediately ingest (calls pipeline directly)
 *
 * Usage in app.ts:
 *   app.route('/api/webhook', buildWebhookRoute(config))
 */
export function buildWebhookRoute(connectorConfig: WebhookConnectorConfig = {}) {
  const route = new Hono()

  // Middleware: optional shared secret check
  route.use('*', async (c, next) => {
    if (connectorConfig.secret) {
      const auth = c.req.header('x-webhook-secret')
      if (auth !== connectorConfig.secret) {
        return c.json({ error: 'Unauthorized' }, 401)
      }
    }
    await next()
  })

  // Queue a memory for next pipeline run
  route.post('/push', zValidator('json', WebhookPayloadSchema), async (c) => {
    const body  = c.req.valid('json')
    const palace = c.get('palace')

    const raw: RawMemory = {
      content:    body.content,
      sourceType: body.sourceType,
      sourceRef:  body.sourceRef,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
      metadata:   { ...body.metadata, connector: 'webhook', palace_id: palace.id },
    }

    pushToBuffer(raw)
    return c.json({ queued: true, sourceRef: raw.sourceRef ?? null })
  })

  // Push + immediately ingest (bypasses scheduled run)
  route.post('/ingest', zValidator('json', WebhookPayloadSchema), async (c) => {
    const body   = c.req.valid('json')
    const db     = c.get('db')
    const palace = c.get('palace')
    const pipelineConfig = c.get('pipelineConfig')

    const raw: RawMemory = {
      content:    body.content,
      sourceType: body.sourceType,
      sourceRef:  body.sourceRef,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
      metadata:   { ...body.metadata, connector: 'webhook', palace_id: palace.id },
    }

    const { ingest } = await import('@locigram/pipeline')
    const result = await ingest([raw], db, pipelineConfig)

    return c.json({ ...result, sourceRef: raw.sourceRef ?? null })
  })

  return route
}
