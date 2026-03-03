import { truths } from '@locigram/db'
import { eq, lt } from 'drizzle-orm'
import type { DB } from '@locigram/db'

const DECAY_RATE_PER_WEEK = 0.10  // 10% confidence lost per week without reinforcement
const ARCHIVE_THRESHOLD   = 0.15  // truths below this are soft-deleted (expiresAt set)

export async function decayTruths(db: DB, palaceId: string): Promise<void> {
  const allTruths = await db
    .select()
    .from(truths)
    .where(eq(truths.palaceId, palaceId))

  const now = Date.now()

  for (const truth of allTruths) {
    const weeksSinceLastSeen = (now - truth.lastSeen.getTime()) / (1000 * 60 * 60 * 24 * 7)
    if (weeksSinceLastSeen < 1) continue  // seen within a week — no decay

    const decayed = truth.confidence * Math.pow(1 - DECAY_RATE_PER_WEEK, weeksSinceLastSeen)

    if (decayed < ARCHIVE_THRESHOLD) {
      // Mark as archived — not deleted, just very low confidence
      await db.update(truths)
        .set({ confidence: 0.0 })
        .where(eq(truths.id, truth.id))
      console.log(`[truth] archived stale truth: ${truth.id} (${truth.statement.slice(0, 60)}...)`)
    } else {
      await db.update(truths)
        .set({ confidence: decayed })
        .where(eq(truths.id, truth.id))
    }
  }
}
