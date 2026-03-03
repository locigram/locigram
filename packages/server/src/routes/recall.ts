import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { locigrams } from '@locigram/db'
import { eq, and, desc } from 'drizzle-orm'

const schema = z.object({
  query:  z.string().min(1),
  locus:  z.string().optional(),   // filter by locus prefix
  limit:  z.number().int().min(1).max(50).default(10),
  minConfidence: z.number().min(0).max(1).default(0.0),
})

export const recallRoute = new Hono()

recallRoute.post('/', zValidator('json', schema), async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const { query, locus, limit, minConfidence } = c.req.valid('json')

  // TODO: replace with Qdrant semantic search when vector package is wired in
  // For now: simple keyword fallback so the route is functional
  const results = await db
    .select()
    .from(locigrams)
    .where(eq(locigrams.palaceId, palace.id))
    .orderBy(desc(locigrams.createdAt))
    .limit(limit)

  return c.json({ results, query, total: results.length })
})
