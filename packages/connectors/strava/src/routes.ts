/**
 * Strava API routes for backfill and OAuth callback.
 */
import { Hono } from 'hono'
import { exchangeCode, getAuthUrl } from './auth'
import { getAthlete } from './client'
import { backfillActivities } from './backfill'

export function buildStravaApiRoute() {
  const route = new Hono()

  // ── OAuth authorize redirect ──────────────────────────────────────────────
  route.get('/auth', (c) => {
    const redirectUri = `${process.env.STRAVA_REDIRECT_URI ?? 'https://mcp.locigram.ai/api/strava/callback'}`
    const url = getAuthUrl(redirectUri)
    return c.redirect(url)
  })

  // ── OAuth callback ────────────────────────────────────────────────────────
  route.get('/callback', async (c) => {
    const code = c.req.query('code')
    if (!code) return c.text('Missing code parameter', 400)

    try {
      const tokens = await exchangeCode(code)
      // In production, you'd store these securely.
      // For now, return them so they can be added to env/1Password.
      return c.json({
        ok: true,
        message: 'Strava authorized! Add these to your environment:',
        STRAVA_ACCESS_TOKEN: tokens.access_token,
        STRAVA_REFRESH_TOKEN: tokens.refresh_token,
        expires_at: new Date(tokens.expires_at * 1000).toISOString(),
      })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ── Athlete profile ───────────────────────────────────────────────────────
  route.get('/athlete', async (c) => {
    try {
      const athlete = await getAthlete()
      return c.json(athlete)
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ── Backfill historical activities ────────────────────────────────────────
  route.post('/backfill', async (c) => {
    const db = c.get('db')
    const pipelineConfig = c.get('pipelineConfig')
    const body = await c.req.json().catch(() => ({})) as {
      after?: string   // ISO date
      before?: string  // ISO date
      detailed?: boolean
      perPage?: number
    }

    try {
      const result = await backfillActivities({
        after: body.after ? new Date(body.after) : undefined,
        before: body.before ? new Date(body.before) : undefined,
        detailed: body.detailed ?? false,
        perPage: body.perPage,
        db,
        pipelineConfig,
      })
      return c.json(result)
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  return route
}
