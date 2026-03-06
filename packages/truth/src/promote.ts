import { truths, locigrams } from '@locigram/db'
import { eq, and, sql, inArray } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import type { ReinforcementGroup } from './detect'

// Confidence scoring: logarithmic — early sources matter more
function scoreConfidence(sourceCount: number): number {
  return Math.min(0.99, Math.log2(sourceCount + 1) / Math.log2(20))
}

export async function promoteToTruth(
  db: DB,
  palaceId: string,
  group: ReinforcementGroup,
  statement: string,  // synthesized statement (or content of most confident locigram)
): Promise<void> {
  const confidence = scoreConfidence(group.count)

  // Check if a truth already exists for this locus + entity combo
  const [existing] = await db
    .select()
    .from(truths)
    .where(
      and(
        eq(truths.palaceId, palaceId),
        eq(truths.locus, group.locus),
        group.entities.length === 0
          ? sql`${truths.entities} = '{}'::text[]`
          : sql`${truths.entities} = ARRAY[${sql.join(group.entities.map(e => sql`${e}`), sql`, `)}]::text[]`,
      )
    )
    .limit(1)

  if (existing) {
    // Reinforce existing truth
    const merged = [...new Set([...existing.locigramIds, ...group.locigramIds])]
    await db.update(truths).set({
      confidence:   Math.max(existing.confidence, confidence),
      sourceCount:  merged.length,
      lastSeen:     new Date(),
      locigramIds:  merged,
    }).where(eq(truths.id, existing.id))
  } else {
    // Create new truth
    await db.insert(truths).values({
      statement,
      locus:       group.locus,
      entities:    group.entities,
      confidence,
      sourceCount: group.count,
      lastSeen:    new Date(),
      locigramIds: group.locigramIds,
      palaceId,
    })
  }

  // Clear cluster_candidate flag on promoted source locigrams
  await db.update(locigrams)
    .set({ clusterCandidate: false })
    .where(and(eq(locigrams.palaceId, palaceId), inArray(locigrams.id, group.locigramIds)))
}
