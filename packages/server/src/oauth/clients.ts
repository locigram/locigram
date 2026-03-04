import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { eq, and, isNull } from 'drizzle-orm'
import { oauthClients } from '@locigram/db'
import type { DB } from '@locigram/db'
import type { Palace } from '@locigram/db'

export const clientsRoute = new Hono()

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
  const { name, redirect_uris } = body as { name?: string; redirect_uris?: string[] }

  if (!name) throw new HTTPException(400, { message: 'name is required' })
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    throw new HTTPException(400, { message: 'redirect_uris must be a non-empty array' })
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
  })

  return c.json({
    client_id: clientId,
    client_secret: clientSecret,
    name,
    redirect_uris,
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
      createdAt: oauthClients.createdAt,
    })
    .from(oauthClients)
    .where(and(eq(oauthClients.palaceId, palace.id), isNull(oauthClients.revokedAt)))

  return c.json(clients.map((cl) => ({
    client_id: cl.id,
    name: cl.name,
    redirect_uris: cl.redirectUris,
    created_at: cl.createdAt,
  })))
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
