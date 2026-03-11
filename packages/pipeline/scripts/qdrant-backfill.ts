#!/usr/bin/env bun
/**
 * Phase 8.4 — Qdrant payload backfill
 *
 * Updates Qdrant point payloads with structured fields (subject, predicate,
 * object_val, durability_class) for all existing embedded locigrams.
 * Does NOT re-embed — vectors stay the same, only metadata changes.
 *
 * Usage:
 *   DATABASE_URL=... bun run scripts/qdrant-backfill.ts [options]
 *
 * Options:
 *   --dry-run        Count records but don't update Qdrant
 *   --palace ID      Scope to specific palace (default: main)
 *   --batch-size N   Records per Qdrant batch update (default: 100)
 */

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '@locigram/db'
import { sql, isNotNull, eq, and, gt } from 'drizzle-orm'
import { locigrams } from '@locigram/db'

const DRY_RUN    = process.argv.includes('--dry-run')
const PALACE_ID  = argVal('--palace') ?? process.env.PALACE_ID ?? 'main'
const BATCH_SIZE = parseInt(argVal('--batch-size') ?? '100') || 100
const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333'

function argVal(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined
}

const DB_URL = process.env.DATABASE_URL
if (!DB_URL) { console.error('[qdrant-backfill] DATABASE_URL is required'); process.exit(1) }

const client = postgres(DB_URL, { max: 5 })
const db = drizzle(client, { schema })
const collection = `locigrams-${PALACE_ID}`

// Count total work
const [{ count: totalWork }] = await db.select({ count: sql<number>`COUNT(*)` })
  .from(locigrams)
  .where(and(
    eq(locigrams.palaceId, PALACE_ID),
    isNotNull(locigrams.embeddingId),
  ))

console.log(`[qdrant-backfill] ${totalWork} points to update in ${collection} (dry_run=${DRY_RUN})`)

let processed = 0
let updated   = 0
let errors    = 0
let lastId: string | null = null

while (true) {
  const conditions = [
    eq(locigrams.palaceId, PALACE_ID),
    isNotNull(locigrams.embeddingId),
  ]
  if (lastId) conditions.push(gt(locigrams.id, lastId))

  const batch = await db.select({
    id:              locigrams.id,
    subject:         locigrams.subject,
    predicate:       locigrams.predicate,
    objectVal:       locigrams.objectVal,
    durabilityClass: locigrams.durabilityClass,
    category:        locigrams.category,
    confidence:      locigrams.confidence,
    locus:           locigrams.locus,
    tier:            locigrams.tier,
  })
    .from(locigrams)
    .where(and(...conditions))
    .orderBy(locigrams.id)
    .limit(BATCH_SIZE)

  if (batch.length === 0) break

  if (!DRY_RUN) {
    // Build Qdrant batch payload update
    const points = batch.map(r => ({
      id: r.id,
      payload: {
        subject:          r.subject ?? null,
        predicate:        r.predicate ?? null,
        object_val:       r.objectVal ?? null,
        durability_class: r.durabilityClass ?? null,
        category:         r.category,
        confidence:       r.confidence,
        locus:            r.locus,
        tier:             r.tier,
      },
    }))

    try {
      const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/payload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: points.map(p => ({
            id: p.id,
            payload: p.payload,
          })),
        }),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.error(`[qdrant-backfill] Qdrant error ${res.status}: ${body.slice(0, 200)}`)
        errors += batch.length
      } else {
        updated += batch.length
      }
    } catch (err: any) {
      console.error(`[qdrant-backfill] fetch error: ${err.message}`)
      errors += batch.length
    }
  } else {
    updated += batch.length
  }

  lastId = batch[batch.length - 1].id
  processed += batch.length

  const pct = totalWork > 0 ? ((processed / Number(totalWork)) * 100).toFixed(1) : '?'
  console.log(`[qdrant-backfill] ${processed}/${totalWork} (${pct}%) — updated: ${updated}, errors: ${errors}`)
}

console.log(`[qdrant-backfill] COMPLETE — processed: ${processed}, updated: ${updated}, errors: ${errors}`)

await client.end()
process.exit(errors > 0 ? 1 : 0)
