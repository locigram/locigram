/**
 * RFC 7591 — Dynamic Client Registration
 * Auto-registers OAuth clients for Claude.ai and other MCP consumers.
 */
import { Hono } from 'hono'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { oauthClients } from '@locigram/db'
import type { DB } from '@locigram/db'
import type { Palace } from '@locigram/db'

export const registerRoute = new Hono()

registerRoute.post('/', async (c) => {
  const db = c.get('db') as DB
  const palace = c.get('palace') as Palace

  const body = await c.req.json().catch(() => ({}))
  const redirectUris: string[] = body.redirect_uris ?? []
  const clientName: string = body.client_name ?? 'Dynamic Client'

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return c.json({ error: 'redirect_uris must be a non-empty array' }, 400)
  }

  const clientId = crypto.randomBytes(16).toString('hex')
  const clientSecret = crypto.randomBytes(32).toString('hex')
  const secretHash = await bcrypt.hash(clientSecret, 10)

  await db.insert(oauthClients).values({
    id: clientId,
    name: clientName,
    secretHash,
    redirectUris,
    palaceId: palace.id,
  })

  return c.json({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
  }, 201)
})
