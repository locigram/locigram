import { Hono } from 'hono'
import { locigrams } from '@locigram/db'
import { eq, and, gte, lte, desc } from 'drizzle-orm'

export const timelineRoute = new Hono()

timelineRoute.get('/', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const since = c.req.query('since') ? new Date(c.req.query('since')!) : undefined
  const until = c.req.query('until') ? new Date(c.req.query('until')!) : undefined
  const locus = c.req.query('locus')
  const limit = parseInt(c.req.query('limit') ?? '50')

  const conditions = [eq(locigrams.palaceId, palace.id)]
  if (since) conditions.push(gte(locigrams.createdAt, since))
  if (until) conditions.push(lte(locigrams.createdAt, until))

  const results = await db
    .select()
    .from(locigrams)
    .where(and(...conditions))
    .orderBy(desc(locigrams.createdAt))
    .limit(limit)

  return c.json({ results, total: results.length })
})
