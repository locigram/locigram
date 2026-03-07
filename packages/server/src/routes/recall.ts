import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { locigrams, retrievalEvents } from '@locigram/db'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { applyLengthNormalization, applyTimeDecay, applyMMRDiversity } from '../scoring'

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

  // Post-Qdrant scoring pipeline
  let scored = results as Array<typeof results[number]>
  scored = applyLengthNormalization(scored, parseInt(process.env.LOCIGRAM_LENGTH_NORM_ANCHOR ?? '500'))
  scored = applyTimeDecay(scored, parseInt(process.env.LOCIGRAM_QUERY_TIME_DECAY_HALFLIFE ?? '60'))
  scored = applyMMRDiversity(scored, parseFloat(process.env.LOCIGRAM_MMR_THRESHOLD ?? '0.85'))

  // Re-sort by adjusted score and apply hard minimum
  scored = scored
    .filter(r => r._score >= (parseFloat(process.env.LOCIGRAM_HARD_MIN_SCORE ?? '0') || 0))
    .sort((a, b) => b._score - a._score)

  // Fire-and-forget — don't block the response
  if (ids.length > 0) {
    db.update(locigrams)
      .set({
        accessCount:     sql`access_count + 1`,
        lastAccessedAt:  new Date(),
      })
      .where(and(eq(locigrams.palaceId, palace.id), inArray(locigrams.id, ids)))
      .catch(err => console.warn('[recall] access_count update failed:', err))

    db.insert(retrievalEvents)
      .values({
        palaceId:    palace.id,
        queryText:   query,
        locigramIds: ids,
      })
      .catch(err => console.warn('[recall] retrieval_events insert failed:', err))
  }

  return c.json({ results: scored, query, total: scored.length })
})
