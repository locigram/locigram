/**
 * Postgres Full-Text Search (FTS) for Locigram
 * Phase 3: Lexical retrieval lane — complements vector + structured search
 *
 * Uses the existing GIN index: locigrams_fts_idx ON locigrams USING GIN(to_tsvector('english', content))
 */

import { sql } from 'drizzle-orm'

export interface FTSResult {
  id: string
  content: string
  rank: number         // ts_rank_cd score
  headline: string     // highlighted snippet
}

export interface FTSOptions {
  palaceId: string
  locus?: string
  sourceType?: string
  category?: string
  limit?: number
  highlightMaxWords?: number
}

/**
 * Full-text search against locigrams.content using Postgres FTS.
 *
 * Uses websearch_to_tsquery for natural language queries (supports quotes, AND, OR, -NOT).
 * Falls back gracefully — returns empty if query produces no tsquery terms.
 */
export async function searchFTS(
  db: any,
  query: string,
  opts: FTSOptions,
): Promise<FTSResult[]> {
  const limit = opts.limit ?? 20
  const hlMaxWords = opts.highlightMaxWords ?? 35

  // Build dynamic WHERE clauses with parameterized values
  const conditions = [
    sql`l.palace_id = ${opts.palaceId}`,
    sql`l.expires_at IS NULL`,
    sql`to_tsvector('english', l.content) @@ websearch_to_tsquery('english', ${query})`,
  ]

  if (opts.locus) {
    const prefix = opts.locus.endsWith('%') ? opts.locus : `${opts.locus}%`
    conditions.push(sql`l.locus LIKE ${prefix}`)
  }
  if (opts.sourceType) {
    conditions.push(sql`l.source_type = ${opts.sourceType}`)
  }
  if (opts.category) {
    conditions.push(sql`l.category = ${opts.category}`)
  }

  const where = sql.join(conditions, sql` AND `)

  try {
    const result = await db.execute(sql`
      SELECT
        l.id,
        l.content,
        ts_rank_cd(
          to_tsvector('english', l.content),
          websearch_to_tsquery('english', ${query})
        ) AS rank,
        ts_headline('english', l.content,
          websearch_to_tsquery('english', ${query}),
          ${'MaxWords=' + hlMaxWords + ', MinWords=10, StartSel=**, StopSel=**'}
        ) AS headline
      FROM locigrams l
      WHERE ${where}
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    return (result.rows ?? result) as FTSResult[]
  } catch (err: any) {
    // websearch_to_tsquery can fail on malformed input — return empty
    console.warn('[fts] search failed:', err.message)
    return []
  }
}
