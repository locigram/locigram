import { locigrams } from '@locigram/db'
import { eq, and, isNull } from 'drizzle-orm'
import type { DB } from '@locigram/db'

// vectorClient typed loosely — wired in app.ts with the actual VectorClient
export function startEmbedWorker(
  db: DB,
  vectorClient: any,
  palaceId: string,
  intervalMs = 30_000,
): () => void {
  const collectionName = `locigrams-${palaceId}`
  let running = true

  async function tick() {
    if (!running) return
    try {
      const unembedded = await db
        .select({ id: locigrams.id, content: locigrams.content })
        .from(locigrams)
        .where(and(eq(locigrams.palaceId, palaceId), isNull(locigrams.embeddingId)))
        .limit(50)

      if (unembedded.length === 0) return

      console.log(`[embed-worker] embedding ${unembedded.length} locigrams`)

      for (const loc of unembedded) {
        try {
          const vector = await vectorClient.embed(loc.content)
          await vectorClient.upsert(collectionName, loc.id, vector, { palace_id: palaceId })
          await db.update(locigrams)
            .set({ embeddingId: loc.id })
            .where(eq(locigrams.id, loc.id))
        } catch (err) {
          console.error(`[embed-worker] failed for ${loc.id}:`, err)
          // Continue — don't stop worker on single failure
        }
      }
    } catch (err) {
      console.error('[embed-worker] tick error:', err)
    }
  }

  const interval = setInterval(tick, intervalMs)
  tick() // run immediately on start

  return () => {
    running = false
    clearInterval(interval)
    console.log('[embed-worker] stopped')
  }
}
