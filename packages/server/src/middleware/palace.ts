import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { DB } from '@locigram/db'
import { palaces } from '@locigram/db'
import { eq } from 'drizzle-orm'

// Injects the palace record into every request context
export const palaceMiddleware = (db: DB, palaceId: string) =>
  createMiddleware(async (c, next) => {
    const [palace] = await db.select().from(palaces).where(eq(palaces.id, palaceId)).limit(1)
    if (!palace) throw new HTTPException(404, { message: `Palace not found: ${palaceId}` })
    c.set('palace', palace)
    c.set('db', db)
    await next()
  })
