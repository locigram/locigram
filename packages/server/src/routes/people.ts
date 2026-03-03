import { Hono } from 'hono'
import { entities, locigrams } from '@locigram/db'
import { eq, and, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'

export const peopleRoute = new Hono()

peopleRoute.get('/:name', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const name = decodeURIComponent(c.req.param('name'))

  // Find canonical entity
  const [entity] = await db
    .select()
    .from(entities)
    .where(and(eq(entities.palaceId, palace.id), eq(entities.name, name)))
    .limit(1)

  if (!entity) throw new HTTPException(404, { message: `Entity not found: ${name}` })

  // Find locigrams mentioning this entity
  const memories = await db
    .select()
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palace.id),
        sql`${locigrams.entities} @> ARRAY[${name}]::text[]`
      )
    )
    .limit(50)

  return c.json({ entity, memories, total: memories.length })
})
