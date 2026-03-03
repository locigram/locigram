import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { locigrams } from '@locigram/db'
import { eq, and, inArray } from 'drizzle-orm'

const schema = z.object({
  query:      z.string().min(1),
  locus:      z.string().optional(),        // filter to a locus prefix (e.g. "business/")
  connector:  z.string().optional(),        // filter to a specific connector (e.g. "halopsa")
  sourceType: z.string().optional(),        // filter to a source type (e.g. "email")
  limit:      z.number().int().min(1).max(50).default(10),
  minScore:   z.number().min(0).max(1).default(0.5),
})

export const recallRoute = new Hono()

recallRoute.post('/', zValidator('json', schema), async (c) => {
  const db           = c.get('db')
  const palace       = c.get('palace')
  const vectorClient = c.get('vectorClient')
  const { query, locus, connector, sourceType, limit, minScore } = c.req.valid('json')

  const collectionName = `locigrams-${palace.id}`

  // Embed query
  const vector = await vectorClient.embed(query)

  // Search Qdrant — pass all filters so vector layer pre-filters before Postgres
  const hits = await vectorClient.search(collectionName, vector, {
    palaceId: palace.id,
    locus,
    connector,
    sourceType,
    limit,
    minScore,
  })

  if (hits.length === 0) return c.json({ results: [], query, total: 0 })

  // Fetch full records from Postgres
  const ids = hits.map((h: { id: string }) => h.id)
  const rows = await db
    .select()
    .from(locigrams)
    .where(and(eq(locigrams.palaceId, palace.id), inArray(locigrams.id, ids)))

  // Re-sort by Qdrant score order, annotate with score
  const scoreMap = new Map(hits.map((h: { id: string; score: number }) => [h.id, h.score]))
  const results  = rows
    .sort((a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0))
    .map(r => ({ ...r, _score: scoreMap.get(r.id) ?? 0 }))

  return c.json({ results, query, total: results.length })
})
