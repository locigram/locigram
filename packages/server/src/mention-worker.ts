/**
 * Mention worker — background GLiNER entity extraction for all locigrams.
 *
 * Polls for locigrams that have NO entity_mentions rows, runs GLiNER on
 * the content, and stores mentions. Covers all ingestion paths:
 * - preClassified connectors (microsoft365, qbo)
 * - remember route (MCP tools, API)
 * - legacy session ingest
 * - any locigrams where GLiNER failed during pipeline extraction
 *
 * Same pattern as embed-worker and graph-worker: polls on interval,
 * processes a batch, retries on next tick if GLiNER is down.
 */

import { locigrams, entityMentions } from '@locigram/db'
import { eq, and, sql, isNull } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import { extractEntitiesWithGLiNER } from '@locigram/pipeline'
import { storeGLiNERMentions } from '@locigram/pipeline'

export function startMentionWorker(
  db: DB,
  palaceId: string,
  intervalMs = 60_000,  // every 60s (GLiNER is slower than embed, don't flood)
): () => void {
  let running = true

  async function tick() {
    if (!running) return

    try {
      // Find locigrams with zero entity_mentions rows
      // Use a LEFT JOIN + IS NULL pattern for efficiency
      const pending = await db
        .select({
          id:       locigrams.id,
          content:  locigrams.content,
          palaceId: locigrams.palaceId,
        })
        .from(locigrams)
        .leftJoin(
          entityMentions,
          and(
            eq(entityMentions.locigramId, locigrams.id),
            eq(entityMentions.source, 'gliner'),
          ),
        )
        .where(and(
          eq(locigrams.palaceId, palaceId),
          isNull(entityMentions.id),
        ))
        .limit(20)

      if (pending.length === 0) return
      console.log(`[mention-worker] processing ${pending.length} locigrams`)

      let stored = 0
      let skipped = 0
      let errors = 0

      for (const loc of pending) {
        try {
          const result = await extractEntitiesWithGLiNER(loc.content)

          if (!result || result.mentions.length === 0) {
            // GLiNER returned nothing — mark as processed by inserting a sentinel
            // (empty row with source='gliner-none' so we don't re-process)
            await db.insert(entityMentions).values({
              locigramId: loc.id,
              entityId:   null,
              rawText:    '',
              type:       'none',
              confidence: 0,
              source:     'gliner-none',
              spanStart:  null,
              spanEnd:    null,
              palaceId:   loc.palaceId,
            })
            skipped++
            continue
          }

          await storeGLiNERMentions(db, {
            locigramId: loc.id,
            palaceId:   loc.palaceId,
          }, result.mentions)

          stored += result.mentions.length
        } catch (err) {
          errors++
          console.warn(`[mention-worker] failed for ${loc.id}:`, (err as Error).message)
          // Don't insert sentinel — will retry next tick
        }
      }

      console.log(`[mention-worker] done — stored=${stored} skipped=${skipped} errors=${errors}`)
    } catch (err) {
      console.error('[mention-worker] tick error:', err)
    }
  }

  const interval = setInterval(tick, intervalMs)
  // Delay first run by 30s to let the server warm up
  const startup = setTimeout(tick, 30_000)

  return () => {
    running = false
    clearInterval(interval)
    clearTimeout(startup)
    console.log('[mention-worker] stopped')
  }
}
