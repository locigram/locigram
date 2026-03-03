import { Hono } from 'hono'
import { truths } from '@locigram/db'
import { eq, and, gte, desc } from 'drizzle-orm'

export const truthsRoute = new Hono()

truthsRoute.get('/', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const locus = c.req.query('locus')
  const minConfidence = parseFloat(c.req.query('minConfidence') ?? '0.7')
  const limit = parseInt(c.req.query('limit') ?? '20')

  const results = await db
    .select()
    .from(truths)
    .where(
      and(
        eq(truths.palaceId, palace.id),
        gte(truths.confidence, minConfidence),
      )
    )
    .orderBy(desc(truths.confidence))
    .limit(limit)

  return c.json({ results, total: results.length })
})
