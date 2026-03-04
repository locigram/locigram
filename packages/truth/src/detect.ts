import { locigrams, truths } from '@locigram/db'
import { eq, and, sql, gte } from 'drizzle-orm'
import type { DB } from '@locigram/db'

// Minimum locigrams making the same claim before promoting to Truth
const REINFORCEMENT_THRESHOLD = 3
const SIMILARITY_WINDOW_DAYS  = 90  // look back 90 days for reinforcing locigrams

export interface ReinforcementGroup {
  locus:       string
  entities:    string[]
  locigramIds: string[]
  count:       number
}

/**
 * Find groups of locigrams that are reinforcing the same idea.
 * Uses entity overlap + locus match as a proxy for "same topic".
 * Full semantic dedup is done at search time — this is for batch Truth promotion.
 */
export async function detectReinforcement(
  db: DB,
  palaceId: string,
): Promise<ReinforcementGroup[]> {
  const since = new Date(Date.now() - SIMILARITY_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // Get knowledge locigrams from the window (skip reference data — it never gets promoted)
  const recent = await db
    .select()
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palaceId),
        eq(locigrams.isReference, false),
        gte(locigrams.createdAt, since),
      )
    )
    .orderBy(locigrams.locus)

  // Group by locus + entity overlap
  const groups = new Map<string, ReinforcementGroup>()

  for (const loc of recent) {
    // Key: locus + sorted entity names
    const key = `${loc.locus}::${[...loc.entities].sort().join(',')}`

    if (groups.has(key)) {
      const g = groups.get(key)!
      g.locigramIds.push(loc.id)
      g.count++
    } else {
      groups.set(key, {
        locus:       loc.locus,
        entities:    loc.entities,
        locigramIds: [loc.id],
        count:       1,
      })
    }
  }

  // Only return groups that meet the reinforcement threshold
  return [...groups.values()].filter(g => g.count >= REINFORCEMENT_THRESHOLD)
}
