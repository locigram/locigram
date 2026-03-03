import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { locigrams } from '@locigram/db'
import { eq, and, inArray, desc } from 'drizzle-orm'

const schema = z.object({
  query:         z.string().min(1),
  locus:         z.string().optional(),
  limit:         z.number().int().min(1).max(50).default(10),
  minConfidence: z.number().min(0).max(1).default(0.0),
  minScore:      z.number().min(0).max(1).default(0.5),
})

export const recallRoute = new Hono()

recallRoute.post('/', zValidator('json', schema), async (c) => {
  const db           = c.get('db')
  const palace       = c.get('palace')
  const vectorClient = c.get('vectorClient')
  const { query, locus, limit, minScore } = c.req.valid('json')

  const collectionName = `locigrams-${palace.id}`

  // Semantic search via Qdrant
  const vector = await vectorClient.embed(query)
  const hits   = await vectorClient.search(collectionName, vector, {
    palaceId: palace.id,
    locus,
    limit,
    minScore,
  })

  if (hits.length === 0) return c.json({ results: [], query, total: 0 })

  // Fetch full records from Postgres
  const ids = hits.map((h: { id: string }) => h.id)
  const results = await db
    .select()
    .from(locigrams)
    .where(and(eq(locigrams.palaceId, palace.id), inArray(locigrams.id, ids)))

  // Re-sort by Qdrant score order
  const scoreMap = new Map(hits.map((h: { id: string; score: number }) => [h.id, h.score]))
  results.sort((a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0))

  return c.json({ results, query, total: results.length })
})
