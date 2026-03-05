import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import crypto from 'node:crypto'
import { eq, and, isNull } from 'drizzle-orm'
import { oauthClients, oauthCodes } from '@locigram/db'
import type { DB } from '@locigram/db'
import type { Palace } from '@locigram/db'

export const authorizeRoute = new Hono()

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// GET /oauth/authorize — show approval page
authorizeRoute.get('/', async (c) => {
  const db = c.get('db') as DB
  const palace = c.get('palace') as Palace

  const clientId = c.req.query('client_id')
  const redirectUri = c.req.query('redirect_uri')
  const state = c.req.query('state') || ''
  const responseType = c.req.query('response_type')
  const codeChallenge = c.req.query('code_challenge') || ''
  const codeChallengeMethod = c.req.query('code_challenge_method') || ''

  if (responseType !== 'code') {
    throw new HTTPException(400, { message: 'response_type must be "code"' })
  }
  if (!clientId || !redirectUri) {
    throw new HTTPException(400, { message: 'client_id and redirect_uri are required' })
  }

  const [client] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.id, clientId), isNull(oauthClients.revokedAt)))
    .limit(1)

  if (!client) {
    throw new HTTPException(400, { message: 'Unknown or revoked client_id' })
  }

  if (!client.redirectUris.includes(redirectUri)) {
    throw new HTTPException(400, { message: 'redirect_uri not registered for this client' })
  }

  if (codeChallenge && codeChallengeMethod !== 'S256' && codeChallengeMethod !== 'plain') {
    throw new HTTPException(400, { message: 'Unsupported code_challenge_method' })
  }

  // Auto-approve: generate code and redirect immediately
  // (Private server — no interactive consent needed)
  const code = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

  await db.insert(oauthCodes).values({
    code,
    clientId,
    redirectUri,
    palaceId: palace.id,
    codeChallenge: codeChallenge || null,
    expiresAt,
  })

  const redirect = new URL(redirectUri)
  redirect.searchParams.set('code', code)
  if (state) redirect.searchParams.set('state', state)
  return c.redirect(redirect.toString())
})

// POST /oauth/authorize — handle approval/denial
authorizeRoute.post('/', async (c) => {
  const db = c.get('db') as DB
  const body = await c.req.parseBody()

  const action = body.action as string
  const clientId = body.client_id as string
  const redirectUri = body.redirect_uri as string
  const state = body.state as string || ''
  const codeChallenge = body.code_challenge as string || ''

  const redirect = new URL(redirectUri)

  if (action === 'deny') {
    redirect.searchParams.set('error', 'access_denied')
    if (state) redirect.searchParams.set('state', state)
    return c.redirect(redirect.toString())
  }

  // Validate client still active
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.id, clientId), isNull(oauthClients.revokedAt)))
    .limit(1)

  if (!client) {
    throw new HTTPException(400, { message: 'Unknown or revoked client_id' })
  }

  if (!client.redirectUris.includes(redirectUri)) {
    throw new HTTPException(400, { message: 'redirect_uri not registered for this client' })
  }

  const code = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

  await db.insert(oauthCodes).values({
    code,
    clientId,
    redirectUri,
    palaceId: client.palaceId,
    codeChallenge: codeChallenge || null,
    expiresAt,
  })

  redirect.searchParams.set('code', code)
  if (state) redirect.searchParams.set('state', state)
  return c.redirect(redirect.toString())
})
