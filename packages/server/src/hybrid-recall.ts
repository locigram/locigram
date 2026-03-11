/**
 * Hybrid Recall — fuses vector, FTS, and structured search results
 * Phase 3: Three-lane retrieval with Reciprocal Rank Fusion (RRF)
 */

import { eq, and, inArray, isNull, desc, sql } from 'drizzle-orm'
import { locigrams, retrievalEvents } from '@locigram/db'
import { searchFTS, type FTSOptions } from './fts'
import { applyLengthNormalization, applyTimeDecay, applyMMRDiversity } from './scoring'

export interface HybridRecallOptions {
  query: string
  palaceId: string
  locus?: string
  sourceType?: string
  connector?: string
  category?: string
  subject?: string
  predicate?: string
  limit?: number
  minScore?: number
  /** Which lanes to run: 'auto' picks the best combo, or specify explicitly */
  mode?: 'auto' | 'vector' | 'fts' | 'structured' | 'hybrid'
}

export interface HybridResult {
  id: string
  content: string
  _score: number
  _lanes: string[]   // which lanes contributed ('vector', 'fts', 'structured')
  [key: string]: unknown
}

/**
 * Reciprocal Rank Fusion — merges ranked lists from multiple retrieval lanes.
 * RRF(d) = Σ 1/(k + rank_i(d)) for each lane i where d appears.
 * k=60 is standard; higher k reduces the impact of top-ranked items.
 */
function reciprocalRankFusion(
  rankedLists: { lane: string; ids: string[] }[],
  k: number = 60,
): Map<string, { score: number; lanes: string[] }> {
  const scores = new Map<string, { score: number; lanes: string[] }>()

  for (const { lane, ids } of rankedLists) {
    for (let rank = 0; rank < ids.length; rank++) {
      const id = ids[rank]
      const existing = scores.get(id) ?? { score: 0, lanes: [] }
      existing.score += 1 / (k + rank + 1)
      existing.lanes.push(lane)
      scores.set(id, existing)
    }
  }

  return scores
}

export async function hybridRecall(
  db: any,
  vectorClient: any,
  opts: HybridRecallOptions,
): Promise<{ results: HybridResult[]; query: string; total: number; lanes: string[] }> {
  const limit = opts.limit ?? 10
  const minScore = opts.minScore ?? 0
  const mode = opts.mode ?? 'auto'
  const collectionName = `locigrams-${opts.palaceId}`

  // Determine which lanes to run
  const hasStructuredFilter = !!(opts.subject || opts.predicate)
  const runVector = mode === 'auto' || mode === 'vector' || mode === 'hybrid'
  const runFTS = mode === 'auto' || mode === 'fts' || mode === 'hybrid'
  const runStructured = mode === 'structured' || (mode === 'auto' && hasStructuredFilter)

  const rankedLists: { lane: string; ids: string[] }[] = []
  const activeLanes: string[] = []
  const fetchLimit = limit * 3  // over-fetch for fusion

  // ── Lane 1: Vector (semantic) ──
  if (runVector) {
    try {
      const queryVector = await vectorClient.embed(opts.query)
      const hits = await vectorClient.search(collectionName, queryVector, {
        palaceId: opts.palaceId,
        locus: opts.locus,
        connector: opts.connector,
        sourceType: opts.sourceType,
        category: opts.category,
        limit: fetchLimit,
        minScore: 0.3,   // low threshold — RRF handles ranking
      })
      if (hits.length > 0) {
        rankedLists.push({ lane: 'vector', ids: hits.map((h: any) => h.id) })
        activeLanes.push('vector')
      }
    } catch (err: any) {
      console.warn('[hybrid-recall] vector lane failed:', err.message)
    }
  }

  // ── Lane 2: FTS (lexical) ──
  if (runFTS) {
    try {
      const ftsOpts: FTSOptions = {
        palaceId: opts.palaceId,
        locus: opts.locus,
        sourceType: opts.sourceType,
        category: opts.category,
        limit: fetchLimit,
      }
      const ftsHits = await searchFTS(db, opts.query, ftsOpts)
      if (ftsHits.length > 0) {
        rankedLists.push({ lane: 'fts', ids: ftsHits.map(h => h.id) })
        activeLanes.push('fts')
      }
    } catch (err: any) {
      console.warn('[hybrid-recall] fts lane failed:', err.message)
    }
  }

  // ── Lane 3: Structured (SPO filter) ──
  if (runStructured) {
    try {
      const conditions = [
        eq(locigrams.palaceId, opts.palaceId),
        isNull(locigrams.expiresAt),
      ]
      if (opts.subject) conditions.push(eq(locigrams.subject, opts.subject))
      if (opts.predicate) conditions.push(eq(locigrams.predicate, opts.predicate))
      if (opts.category) conditions.push(eq(locigrams.category, opts.category as any))
      if (opts.locus) conditions.push(sql`${locigrams.locus} LIKE ${opts.locus + '%'}`)

      const structHits = await db.select({ id: locigrams.id })
        .from(locigrams)
        .where(and(...conditions))
        .orderBy(desc(locigrams.createdAt))
        .limit(fetchLimit)

      if (structHits.length > 0) {
        rankedLists.push({ lane: 'structured', ids: structHits.map((r: any) => r.id) })
        activeLanes.push('structured')
      }
    } catch (err: any) {
      console.warn('[hybrid-recall] structured lane failed:', err.message)
    }
  }

  // No results from any lane
  if (rankedLists.length === 0) {
    return { results: [], query: opts.query, total: 0, lanes: activeLanes }
  }

  // ── Fuse with RRF ──
  const fused = reciprocalRankFusion(rankedLists)

  // Sort by fused score, take top N
  const sorted = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)

  const ids = sorted.map(([id]) => id)

  // Fetch full records
  const rows = await db.select().from(locigrams)
    .where(and(eq(locigrams.palaceId, opts.palaceId), inArray(locigrams.id, ids)))

  const rowMap = new Map(rows.map((r: any) => [r.id, r]))

  let results: HybridResult[] = sorted
    .map(([id, { score, lanes }]) => {
      const row = rowMap.get(id)
      if (!row) return null
      return { ...row, _score: score, _lanes: lanes, text: row.content }
    })
    .filter(Boolean) as HybridResult[]

  // Post-scoring pipeline
  results = applyLengthNormalization(results as any, parseInt(process.env.LOCIGRAM_LENGTH_NORM_ANCHOR ?? '500')) as any
  results = applyTimeDecay(results as any, parseInt(process.env.LOCIGRAM_QUERY_TIME_DECAY_HALFLIFE ?? '60')) as any
  results = applyMMRDiversity(results as any, parseFloat(process.env.LOCIGRAM_MMR_THRESHOLD ?? '0.85')) as any

  // Apply min score filter
  if (minScore > 0) {
    results = results.filter(r => r._score >= minScore)
  }

  // Fire-and-forget: update access counts + log retrieval event
  if (ids.length > 0) {
    db.update(locigrams)
      .set({
        accessCount: sql`access_count + 1`,
        lastAccessedAt: new Date(),
      })
      .where(and(eq(locigrams.palaceId, opts.palaceId), inArray(locigrams.id, ids)))
      .catch((err: any) => console.warn('[hybrid-recall] access_count update failed:', err))

    db.insert(retrievalEvents)
      .values({
        palaceId: opts.palaceId,
        queryText: opts.query,
        locigramIds: ids,
      })
      .catch((err: any) => console.warn('[hybrid-recall] retrieval_events insert failed:', err))
  }

  return { results, query: opts.query, total: results.length, lanes: activeLanes }
}
