import { locigrams } from '@locigram/db'
import { eq, and, isNull, inArray } from 'drizzle-orm'
import type { DB } from '@locigram/db'

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
        .select({
          id:          locigrams.id,
          content:     locigrams.content,
          locus:       locigrams.locus,
          sourceType:  locigrams.sourceType,
          connector:   locigrams.connector,
          entities:    locigrams.entities,
          confidence:  locigrams.confidence,
          tier:        locigrams.tier,
          isReference: locigrams.isReference,
          createdAt:   locigrams.createdAt,
        })
        .from(locigrams)
        // Only embed hot/warm — cold tier stays in Postgres only
        .where(and(
          eq(locigrams.palaceId, palaceId),
          isNull(locigrams.embeddingId),
          inArray(locigrams.tier, ['hot', 'warm']),
        ))
        .limit(50)

      if (unembedded.length === 0) return
      console.log(`[embed-worker] embedding ${unembedded.length} locigrams`)

      for (const loc of unembedded) {
        try {
          const vector = await vectorClient.embed(loc.content)

          // Payload stored in Qdrant — used for filtering at search time
          const payload = {
            palace_id:    palaceId,
            locus:        loc.locus,
            source_type:  loc.sourceType,
            connector:    loc.connector ?? loc.sourceType,
            entities:     loc.entities,
            confidence:   loc.confidence,
            tier:         loc.tier,
            is_reference: loc.isReference,
            created_at:   loc.createdAt.toISOString(),
          }

          await vectorClient.upsert(collectionName, loc.id, vector, payload)

          await db.update(locigrams)
            .set({ embeddingId: loc.id })
            .where(eq(locigrams.id, loc.id))
        } catch (err) {
          console.error(`[embed-worker] failed for ${loc.id}:`, err)
        }
      }
    } catch (err) {
      console.error('[embed-worker] tick error:', err)
    }
  }

  const interval = setInterval(tick, intervalMs)
  tick()

  return () => {
    running = false
    clearInterval(interval)
    console.log('[embed-worker] stopped')
  }
}
