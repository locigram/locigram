import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { eq, and, isNull } from 'drizzle-orm'
import { oauthClients, oauthCodes, palaces } from '@locigram/db'
import type { DB } from '@locigram/db'

export const tokenRoute = new Hono()

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

// POST /oauth/token
tokenRoute.post('/', async (c) => {
  const db = c.get('db') as DB
  const body = await c.req.parseBody()

  const grantType = body.grant_type as string
  const code = body.code as string
  const redirectUri = body.redirect_uri as string
  const clientId = body.client_id as string
  const clientSecret = body.client_secret as string
  const codeVerifier = body.code_verifier as string | undefined

  if (grantType !== 'authorization_code') {
    throw new HTTPException(400, { message: 'grant_type must be "authorization_code"' })
  }
  if (!code || !redirectUri || !clientId || !clientSecret) {
    throw new HTTPException(400, { message: 'code, redirect_uri, client_id, and client_secret are required' })
  }

  // Validate client
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.id, clientId), isNull(oauthClients.revokedAt)))
    .limit(1)

  if (!client) {
    throw new HTTPException(401, { message: 'Invalid client_id or client revoked' })
  }

  const secretValid = await bcrypt.compare(clientSecret, client.secretHash)
  if (!secretValid) {
    throw new HTTPException(401, { message: 'Invalid client_secret' })
  }

  // Validate code
  const [authCode] = await db
    .select()
    .from(oauthCodes)
    .where(eq(oauthCodes.code, code))
    .limit(1)

  if (!authCode) {
    throw new HTTPException(400, { message: 'Invalid authorization code' })
  }

  if (authCode.usedAt) {
    throw new HTTPException(400, { message: 'Authorization code already used' })
  }

  if (new Date() > authCode.expiresAt) {
    throw new HTTPException(400, { message: 'Authorization code expired' })
  }

  if (authCode.clientId !== clientId) {
    throw new HTTPException(400, { message: 'Code was not issued to this client' })
  }

  if (authCode.redirectUri !== redirectUri) {
    throw new HTTPException(400, { message: 'redirect_uri mismatch' })
  }

  // PKCE verification
  if (authCode.codeChallenge) {
    if (!codeVerifier) {
      throw new HTTPException(400, { message: 'code_verifier is required (PKCE)' })
    }
    const hash = crypto.createHash('sha256').update(codeVerifier).digest()
    const computed = base64url(hash)
    if (computed !== authCode.codeChallenge) {
      throw new HTTPException(400, { message: 'PKCE code_verifier mismatch' })
    }
  }

  // Mark code as used
  await db
    .update(oauthCodes)
    .set({ usedAt: new Date() })
    .where(eq(oauthCodes.code, code))

  // Fetch palace api_token
  const [palace] = await db
    .select({ apiToken: palaces.apiToken })
    .from(palaces)
    .where(eq(palaces.id, authCode.palaceId))
    .limit(1)

  if (!palace || !palace.apiToken) {
    throw new HTTPException(500, { message: 'Palace has no API token configured' })
  }

  return c.json({
    access_token: palace.apiToken,
    token_type: 'bearer',
    scope: 'mcp',
  })
})
