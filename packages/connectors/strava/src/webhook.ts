/**
 * Strava webhook handler for real-time activity notifications.
 *
 * Strava sends:
 * - GET  /api/webhook/strava — subscription validation (hub.challenge)
 * - POST /api/webhook/strava — event notifications (activity create/update/delete)
 *
 * We only process activity create/update — fetch full details and ingest.
 */
import { Hono } from 'hono'
import { getActivityDetail } from './client'
import { transformActivity } from './transform'

export function buildStravaWebhookRoute() {
  const route = new Hono()

  // ── Webhook validation (GET) ──────────────────────────────────────────────
  route.get('/', (c) => {
    const mode = c.req.query('hub.mode')
    const token = c.req.query('hub.verify_token')
    const challenge = c.req.query('hub.challenge')

    const verifyToken = process.env.STRAVA_VERIFY_TOKEN ?? 'locigram-strava'

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('[strava] Webhook subscription verified')
      return c.json({ 'hub.challenge': challenge })
    }

    return c.text('Forbidden', 403)
  })

  // ── Event handler (POST) ──────────────────────────────────────────────────
  route.post('/', async (c) => {
    try {
      const event = await c.req.json() as {
        object_type: string      // 'activity' | 'athlete'
        object_id: number
        aspect_type: string      // 'create' | 'update' | 'delete'
        owner_id: number
        subscription_id: number
        event_time: number
        updates?: Record<string, unknown>
      }

      // Always acknowledge immediately (Strava expects 200 within 2 seconds)
      // Process asynchronously
      if (event.object_type !== 'activity') {
        return c.json({ ok: true, skipped: 'not an activity event' })
      }

      if (event.aspect_type === 'delete') {
        console.log(`[strava] Activity ${event.object_id} deleted — skipping`)
        return c.json({ ok: true, skipped: 'delete event' })
      }

      // Fetch, transform, and ingest in the background
      // (Strava wants fast 200 response)
      const palace = c.get('palace')
      const db = c.get('db')
      const pipelineConfig = c.get('pipelineConfig')

      // Don't await — respond immediately, process async
      processActivity(event.object_id, event.aspect_type, db, pipelineConfig).catch(err => {
        console.error(`[strava] Failed to process activity ${event.object_id}:`, err)
      })

      return c.json({ ok: true, processing: event.object_id })
    } catch (err: any) {
      console.error('[strava] Webhook error:', err)
      return c.json({ error: err.message }, 500)
    }
  })

  return route
}

async function processActivity(
  activityId: number,
  aspectType: string,
  db: any,
  pipelineConfig: any,
) {
  console.log(`[strava] Processing activity ${activityId} (${aspectType})...`)

  const detail = await getActivityDetail(activityId)
  const memory = transformActivity(detail)

  const { ingest } = await import('@locigram/pipeline')
  const result = await ingest([memory], db, pipelineConfig)

  console.log(`[strava] Activity ${activityId} "${detail.name}" ingested: stored=${result.stored}, skipped=${result.skipped}`)
}
