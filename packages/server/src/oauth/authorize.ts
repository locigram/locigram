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

  if (codeChallenge && codeChallengeMethod !== 'S256') {
    throw new HTTPException(400, { message: 'Only S256 code_challenge_method is supported' })
  }

  const html = `<!DOCTYPE html>
<html>
<head><title>Authorize ${escapeHtml(client.name)}</title>
<style>body{font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px}
.btn{padding:10px 24px;border:none;border-radius:6px;cursor:pointer;font-size:16px;margin:8px}
.approve{background:#2563eb;color:#fff} .deny{background:#e5e7eb;color:#333}</style></head>
<body>
<h2>${escapeHtml(palace.name)}</h2>
<p><strong>${escapeHtml(client.name)}</strong> is requesting access to your Locigram memory palace.</p>
<form method="POST" action="/oauth/authorize">
  <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
  <input type="hidden" name="code_challenge_method" value="S256">
  <button class="btn approve" name="action" value="approve">Approve</button>
  <button class="btn deny" name="action" value="deny">Deny</button>
</form>
</body></html>`

  return c.html(html)
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
