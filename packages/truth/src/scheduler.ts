import type { DB } from '@locigram/db'
import { detectReinforcement } from './detect'
import { promoteToTruth } from './promote'
import { decayTruths } from './decay'
import { locigrams } from '@locigram/db'
import { eq, inArray } from 'drizzle-orm'

export interface TruthEngineConfig {
  palaceId:   string
  intervalMs: number  // how often to run (default: 6 hours)
}

export function startTruthEngine(db: DB, config: TruthEngineConfig): () => void {
  let running = true

  async function tick() {
    if (!running) return
    console.log('[truth-engine] running...')

    try {
      // 1. Detect reinforcement groups
      const groups = await detectReinforcement(db, config.palaceId)
      console.log(`[truth-engine] found ${groups.length} reinforcement groups`)

      // 2. Promote each group to a Truth
      for (const group of groups) {
        // Use the most confident locigram's content as the statement
        const [anchor] = await db
          .select({ content: locigrams.content })
          .from(locigrams)
          .where(inArray(locigrams.id, group.locigramIds))
          .orderBy(locigrams.confidence)
          .limit(1)

        if (anchor) {
          await promoteToTruth(db, config.palaceId, group, anchor.content)
        }
      }

      // 3. Decay stale truths
      await decayTruths(db, config.palaceId)

      console.log('[truth-engine] done')
    } catch (err) {
      console.error('[truth-engine] error:', err)
    }
  }

  const interval = setInterval(tick, config.intervalMs)
  tick()  // run immediately on start

  return () => {
    running = false
    clearInterval(interval)
    console.log('[truth-engine] stopped')
  }
}
