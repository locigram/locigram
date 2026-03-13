/**
 * Strava API routes.
 * Split into public (OAuth) and protected (backfill, athlete) routes.
 */
import { Hono } from 'hono'
import { exchangeCode, getAuthUrl } from './auth'
import { getAthlete } from './client'
import { backfillActivities } from './backfill'

/**
 * Public routes — no palace auth required.
 * OAuth redirect + callback from Strava.
 */
export function buildStravaPublicRoute() {
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
      return c.json({
        ok: true,
        message: 'Strava authorized! Tokens have been cached in-memory. Run backfill now.',
        expires_at: new Date(tokens.expires_at * 1000).toISOString(),
        // Don't expose tokens in response — they're cached in the auth module
      })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  return route
}

/**
 * Protected routes — require palace Bearer token auth.
 * Athlete info and backfill.
 */
export function buildStravaProtectedRoute() {
  const route = new Hono()

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

// Legacy export for backwards compat
export const buildStravaApiRoute = buildStravaPublicRoute
