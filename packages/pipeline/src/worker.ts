import { locigrams } from '@locigram/db'
import { eq, and, isNull, inArray, not, like } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import { isNoise } from './noise-filter'

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
          id:              locigrams.id,
          content:         locigrams.content,
          locus:           locigrams.locus,
          sourceType:      locigrams.sourceType,
          connector:       locigrams.connector,
          entities:        locigrams.entities,
          confidence:      locigrams.confidence,
          category:        locigrams.category,
          tier:            locigrams.tier,
          isReference:     locigrams.isReference,
          createdAt:       locigrams.createdAt,
          subject:         locigrams.subject,
          predicate:       locigrams.predicate,
          objectVal:       locigrams.objectVal,
          durabilityClass: locigrams.durabilityClass,
        })
        .from(locigrams)
        // Only embed hot/warm — cold tier stays in Postgres only
        // Skip heartbeat loci — they're operational telemetry, not knowledge
        .where(and(
          eq(locigrams.palaceId, palaceId),
          isNull(locigrams.embeddingId),
          inArray(locigrams.tier, ['hot', 'warm']),
          not(like(locigrams.locus, '%/heartbeat')),
        ))
        .limit(50)

      if (unembedded.length === 0) return
      console.log(`[embed-worker] embedding ${unembedded.length} locigrams`)

      for (const loc of unembedded) {
        try {
          // Skip noise content from embedding — saves Qdrant space and search quality
          if (isNoise(loc.content)) {
            // Mark as "embedded" with a sentinel so we don't re-process
            await db.update(locigrams)
              .set({ embeddingId: `skip:noise:${loc.id}` })
              .where(eq(locigrams.id, loc.id))
            continue
          }

          const vector = await vectorClient.embed(loc.content)

          // Payload stored in Qdrant — used for filtering at search time
          const payload = {
            palace_id:        palaceId,
            locus:            loc.locus,
            source_type:      loc.sourceType,
            connector:        loc.connector ?? loc.sourceType,
            entities:         loc.entities,
            confidence:       loc.confidence,
            category:         loc.category,
            tier:             loc.tier,
            is_reference:     loc.isReference,
            created_at:       loc.createdAt.toISOString(),
            subject:          loc.subject ?? null,
            predicate:        loc.predicate ?? null,
            object_val:       loc.objectVal ?? null,
            durability_class: loc.durabilityClass ?? null,
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
