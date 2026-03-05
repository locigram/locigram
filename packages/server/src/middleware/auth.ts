import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { oauthAccessTokens, oauthClients } from '@locigram/db'
import { eq, and, isNull, gt } from 'drizzle-orm'
import crypto from 'node:crypto'
import type { DB } from '@locigram/db'

export const authMiddleware = createMiddleware(async (c, next) => {
  // Extract token from Authorization header or cookie
  let token = c.req.header('Authorization')?.replace('Bearer ', '').trim()
  if (!token) {
    const cookie = c.req.header('Cookie') ?? ''
    const match = cookie.match(/locigram_token=([^;]+)/)
    token = match?.[1]
  }

  if (!token) {
    throw new HTTPException(401, { message: 'Missing Authorization header' })
  }

  const db = c.get('db') as DB
  const palace = c.get('palace')

  // 1. Check palace master token (internal/direct access — no service context)
  if (palace?.apiToken && token === palace.apiToken) {
    c.set('oauthService', null)
    c.set('oauthClientId', null)
    await next()
    return
  }

  // 2. Check per-client OAuth access token
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const now = new Date()

  const [accessToken] = await db
    .select({
      id:        oauthAccessTokens.id,
      clientId:  oauthAccessTokens.clientId,
      palaceId:  oauthAccessTokens.palaceId,
      expiresAt: oauthAccessTokens.expiresAt,
    })
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, now),
      )
    )
    .limit(1)

  if (!accessToken) {
    throw new HTTPException(403, { message: 'Invalid or expired token' })
  }

  // Verify token belongs to this palace
  if (accessToken.palaceId !== palace.id) {
    throw new HTTPException(403, { message: 'Token not valid for this palace' })
  }

  // Load client to get service
  const [client] = await db
    .select({ service: oauthClients.service, name: oauthClients.name })
    .from(oauthClients)
    .where(eq(oauthClients.id, accessToken.clientId))
    .limit(1)

  // Update last_used_at (fire and forget)
  db.update(oauthAccessTokens)
    .set({ lastUsedAt: now })
    .where(eq(oauthAccessTokens.id, accessToken.id))
    .catch(() => {})

  c.set('oauthService', client?.service ?? null)
  c.set('oauthClientId', accessToken.clientId)

  await next()
})
