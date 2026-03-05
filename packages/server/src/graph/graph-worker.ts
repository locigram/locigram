/**
 * Graph sync worker — mirrors the embed worker pattern.
 * Polls for locigrams with graphSyncedAt IS NULL every 30s,
 * writes them to Memgraph, marks them done.
 * If Memgraph is down, records stay NULL and get retried next tick.
 */
import { locigrams } from '@locigram/db'
import { eq, and, isNull } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import { writeMemoryToGraph, parseAgentFromLocus } from './graph-write'
import { getGraphDriver } from './graph-client'

export function startGraphWorker(
  db: DB,
  palaceId: string,
  intervalMs = 30_000,
): () => void {
  let running = true

  async function tick() {
    if (!running) return

    // Skip if Memgraph isn't configured
    if (!getGraphDriver()) return

    try {
      const pending = await db
        .select({
          id:          locigrams.id,
          palaceId:    locigrams.palaceId,
          locus:       locigrams.locus,
          sourceType:  locigrams.sourceType,
          connector:   locigrams.connector,
          importance:  locigrams.importance,
          occurredAt:  locigrams.occurredAt,
          createdAt:   locigrams.createdAt,
          metadata:    locigrams.metadata,
        })
        .from(locigrams)
        .where(and(
          eq(locigrams.palaceId, palaceId),
          isNull(locigrams.graphSyncedAt),
        ))
        .limit(50)

      if (pending.length === 0) return
      console.log(`[graph-worker] syncing ${pending.length} locigrams to Memgraph`)

      for (const loc of pending) {
        try {
          const meta = loc.metadata as Record<string, unknown> ?? {}
          const sessionId = (meta.session_id ?? meta.sessionId) as string | undefined

          await writeMemoryToGraph({
            id:          loc.id,
            palaceId:    loc.palaceId,
            locus:       loc.locus ?? 'unknown',
            sourceType:  loc.sourceType,
            agentName:   parseAgentFromLocus(loc.locus ?? ''),
            sessionId,
            importance:  loc.importance,
            occurredAt:  loc.occurredAt ?? loc.createdAt,
            connector:   loc.connector,
          })

          await db.update(locigrams)
            .set({ graphSyncedAt: new Date() })
            .where(eq(locigrams.id, loc.id))
        } catch (err) {
          console.warn(`[graph-worker] failed for ${loc.id}:`, err)
          // Don't rethrow — graphSyncedAt stays null, retried next tick
        }
      }
    } catch (err) {
      console.error('[graph-worker] tick error:', err)
    }
  }

  const interval = setInterval(tick, intervalMs)
  tick() // run immediately on start

  return () => {
    running = false
    clearInterval(interval)
    console.log('[graph-worker] stopped')
  }
}
