import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { eq, and, isNull, gt } from 'drizzle-orm'
import { oauthClients, oauthAccessTokens } from '@locigram/db'
import type { DB } from '@locigram/db'
import type { Palace } from '@locigram/db'

export const clientsRoute = new Hono()

const VALID_SERVICES = ['claude','chatgpt','gemini','perplexity','copilot','grok','mistral','llama','other']

function requireAuth(c: any): { db: DB; palace: Palace } {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) throw new HTTPException(401, { message: 'Missing Authorization header' })

  const palace = c.get('palace') as Palace
  if (!palace.apiToken || token !== palace.apiToken) {
    throw new HTTPException(403, { message: 'Invalid token' })
  }

  return { db: c.get('db') as DB, palace }
}

// POST /oauth/clients — create new client
clientsRoute.post('/', async (c) => {
  const { db, palace } = requireAuth(c)
  const body = await c.req.json()
  const { name, redirect_uris, service } = body as { name?: string; redirect_uris?: string[]; service?: string }

  if (!name) throw new HTTPException(400, { message: 'name is required' })
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    throw new HTTPException(400, { message: 'redirect_uris must be a non-empty array' })
  }
  if (service && !VALID_SERVICES.includes(service)) {
    throw new HTTPException(400, { message: `service must be one of: ${VALID_SERVICES.join(', ')}` })
  }

  const clientId = crypto.randomBytes(16).toString('hex')
  const clientSecret = crypto.randomBytes(32).toString('hex')
  const secretHash = await bcrypt.hash(clientSecret, 10)

  await db.insert(oauthClients).values({
    id: clientId,
    name,
    secretHash,
    redirectUris: redirect_uris,
    palaceId: palace.id,
    service: service ?? null,
  })

  return c.json({
    client_id: clientId,
    client_secret: clientSecret,
    name,
    redirect_uris,
    service: service ?? null,
  }, 201)
})

// GET /oauth/clients — list active clients
clientsRoute.get('/', async (c) => {
  const { db, palace } = requireAuth(c)

  const clients = await db
    .select({
      id: oauthClients.id,
      name: oauthClients.name,
      redirectUris: oauthClients.redirectUris,
      service: oauthClients.service,
      createdAt: oauthClients.createdAt,
    })
    .from(oauthClients)
    .where(and(eq(oauthClients.palaceId, palace.id), isNull(oauthClients.revokedAt)))

  return c.json(clients.map((cl) => ({
    client_id: cl.id,
    name: cl.name,
    redirect_uris: cl.redirectUris,
    service: cl.service,
    created_at: cl.createdAt,
  })))
})

// PATCH /oauth/clients/:id — update service on existing client
clientsRoute.patch('/:id', async (c) => {
  const { db, palace } = requireAuth(c)
  const clientId = c.req.param('id')
  const body = await c.req.json()
  const { service } = body as { service?: string }

  if (service && !VALID_SERVICES.includes(service)) {
    throw new HTTPException(400, { message: `service must be one of: ${VALID_SERVICES.join(', ')}` })
  }

  const result = await db
    .update(oauthClients)
    .set({ service: service ?? null })
    .where(and(
      eq(oauthClients.id, clientId),
      eq(oauthClients.palaceId, palace.id),
      isNull(oauthClients.revokedAt),
    ))
    .returning({ id: oauthClients.id, service: oauthClients.service })

  if (result.length === 0) {
    throw new HTTPException(404, { message: 'Client not found or revoked' })
  }

  return c.json({ client_id: clientId, service: result[0].service })
})

// DELETE /oauth/clients/:id — revoke client
clientsRoute.delete('/:id', async (c) => {
  const { db, palace } = requireAuth(c)
  const clientId = c.req.param('id')

  const result = await db
    .update(oauthClients)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(oauthClients.id, clientId),
      eq(oauthClients.palaceId, palace.id),
      isNull(oauthClients.revokedAt),
    ))
    .returning({ id: oauthClients.id })

  if (result.length === 0) {
    throw new HTTPException(404, { message: 'Client not found or already revoked' })
  }

  return c.json({ revoked: true, client_id: clientId })
})

// GET /oauth/clients/tokens — list active access tokens
clientsRoute.get('/tokens', async (c) => {
  const { db, palace } = requireAuth(c)

  const tokens = await db
    .select({
      clientId:   oauthAccessTokens.clientId,
      createdAt:  oauthAccessTokens.createdAt,
      expiresAt:  oauthAccessTokens.expiresAt,
      lastUsedAt: oauthAccessTokens.lastUsedAt,
      clientName: oauthClients.name,
      service:    oauthClients.service,
    })
    .from(oauthAccessTokens)
    .leftJoin(oauthClients, eq(oauthAccessTokens.clientId, oauthClients.id))
    .where(
      and(
        eq(oauthAccessTokens.palaceId, palace.id),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
      )
    )
    .orderBy(oauthAccessTokens.createdAt)

  return c.json(tokens)
})
