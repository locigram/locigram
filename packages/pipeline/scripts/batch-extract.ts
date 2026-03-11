#!/usr/bin/env bun
/**
 * Phase 8.1-8.2 — Batch extraction of structured fields for historical memories
 *
 * Iterates all active locigrams without structured fields (subject IS NULL),
 * runs LLM extraction, and updates in-place. Resume-safe via checkpoint file.
 *
 * Usage:
 *   DATABASE_URL=... bun run scripts/batch-extract.ts [options]
 *
 * Options:
 *   --dry-run        Extract but don't write to DB
 *   --limit N        Process at most N records
 *   --palace ID      Scope to specific palace (default: main)
 *   --batch-size N   Records per batch (default: 50)
 *   --concurrency N  Parallel LLM calls per batch (default: 1)
 *   --no-resume      Ignore checkpoint, start fresh
 */

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '@locigram/db'
import { sql, isNull, eq, and, gt } from 'drizzle-orm'
import { locigrams } from '@locigram/db'
import { extractFromRaw } from '../src/extract'
import { defaultLLMConfig } from '../src/config'
import { qualityGate } from '../src/noise-filter'
import type { PipelineConfig } from '../src/config'
import type { RawMemory } from '@locigram/core'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// ── CLI args ──────────────────────────────────────────────────────────────────

const DRY_RUN     = process.argv.includes('--dry-run')
const NO_RESUME   = process.argv.includes('--no-resume')
const PALACE_ID   = argVal('--palace') ?? process.env.PALACE_ID ?? 'main'
const LIMIT       = parseInt(argVal('--limit') ?? '0') || 0
const BATCH_SIZE  = parseInt(argVal('--batch-size') ?? '50') || 50
const CONCURRENCY = parseInt(argVal('--concurrency') ?? '1') || 1

function argVal(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

const CHECKPOINT_FILE = join(import.meta.dir, `.batch-checkpoint-${PALACE_ID}`)

function loadCheckpoint(): string | null {
  if (NO_RESUME) return null
  try {
    if (existsSync(CHECKPOINT_FILE)) {
      const data = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8'))
      console.log(`[batch] resuming from checkpoint: ${data.lastId?.slice(0, 8)} (${data.processed} processed)`)
      return data.lastId
    }
  } catch {}
  return null
}

function saveCheckpoint(lastId: string, processed: number, updated: number, skipped: number, errors: number) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({ lastId, processed, updated, skipped, errors, savedAt: new Date().toISOString() }))
}

function clearCheckpoint() {
  try { if (existsSync(CHECKPOINT_FILE)) require('fs').unlinkSync(CHECKPOINT_FILE) } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL
if (!DB_URL) { console.error('[batch] DATABASE_URL is required'); process.exit(1) }

const client = postgres(DB_URL, { max: 5 })
const db = drizzle(client, { schema })

const pipelineConfig: PipelineConfig = {
  palaceId: PALACE_ID,
  llm: defaultLLMConfig(),
}

let totalProcessed = 0
let totalUpdated   = 0
let totalSkipped   = 0
let totalErrors    = 0

const resumeFrom = loadCheckpoint()

console.log(`[batch] Phase 8 — batch extraction (palace=${PALACE_ID}, dry_run=${DRY_RUN}, limit=${LIMIT || 'all'}, batch=${BATCH_SIZE}, concurrency=${CONCURRENCY})`)

// Count total work
const [{ count: totalWork }] = await db.select({ count: sql<number>`COUNT(*)` })
  .from(locigrams)
  .where(and(
    eq(locigrams.palaceId, PALACE_ID),
    isNull(locigrams.subject),
    isNull(locigrams.expiresAt),
  ))

console.log(`[batch] ${totalWork} records need extraction`)

let lastId = resumeFrom
let batchNum = 0

while (true) {
  // Fetch next batch, ordered by ID for stable pagination
  const conditions = [
    eq(locigrams.palaceId, PALACE_ID),
    isNull(locigrams.subject),
    isNull(locigrams.expiresAt),
  ]
  if (lastId) conditions.push(gt(locigrams.id, lastId))

  // Cap batch size to remaining limit
  const fetchSize = LIMIT > 0 ? Math.min(BATCH_SIZE, LIMIT - totalProcessed) : BATCH_SIZE

  const batch = await db.select({
    id:         locigrams.id,
    content:    locigrams.content,
    sourceType: locigrams.sourceType,
    sourceRef:  locigrams.sourceRef,
    connector:  locigrams.connector,
    occurredAt: locigrams.occurredAt,
    metadata:   locigrams.metadata,
    locus:      locigrams.locus,
  })
    .from(locigrams)
    .where(and(...conditions))
    .orderBy(locigrams.id)
    .limit(fetchSize)

  if (batch.length === 0) break
  batchNum++

  // Process records (with concurrency control)
  const chunks: typeof batch[] = []
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    chunks.push(batch.slice(i, i + CONCURRENCY))
  }

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (record) => {
      try {
        // Build a RawMemory-like object for extractFromRaw
        const raw: RawMemory = {
          content:    record.content,
          sourceType: record.sourceType as any,
          sourceRef:  record.sourceRef ?? undefined,
          occurredAt: record.occurredAt ?? undefined,
          metadata:   (record.metadata as Record<string, unknown>) ?? {},
        }

        const extraction = await extractFromRaw(raw, pipelineConfig)

        // Apply quality gate (same as ingest pipeline)
        extraction.locigrams = qualityGate(extraction.locigrams as any) as any

        // Take the first locigram's structured fields (primary extraction)
        const primary = extraction.locigrams[0]
        if (!primary || !primary.subject) {
          // Extraction returned no SPO — legitimately unstructured content
          totalSkipped++
          totalProcessed++
          return
        }

        if (!DRY_RUN) {
          await db.update(locigrams)
            .set({
              subject:         primary.subject,
              predicate:       primary.predicate ?? null,
              objectVal:       primary.object_val ?? null,
              category:        primary.category ?? 'observation',
              durabilityClass: primary.durability_class ?? 'active',
              confidence:      primary.confidence,
              // Update locus if extraction found a better one (not the default)
              ...(extraction.locus !== 'personal/general' ? { locus: extraction.locus } : {}),
            })
            .where(eq(locigrams.id, record.id))
        }

        totalUpdated++
        totalProcessed++
      } catch (err: any) {
        totalErrors++
        totalProcessed++
        console.error(`[batch] error on ${record.id.slice(0, 8)}: ${err.message}`)

        // Backoff on rate limit or gateway errors
        if (err.message?.includes('429') || err.message?.includes('rate') || err.message?.includes('502') || err.message?.includes('503')) {
          const wait = err.message?.includes('429') ? 30_000 : 10_000
          console.log(`[batch] LLM unavailable — waiting ${wait / 1000}s`)
          await new Promise(r => setTimeout(r, wait))
        }
      }
    }))
  }

  lastId = batch[batch.length - 1].id
  saveCheckpoint(lastId, totalProcessed, totalUpdated, totalSkipped, totalErrors)

  const pct = totalWork > 0 ? ((totalProcessed / Number(totalWork)) * 100).toFixed(1) : '?'
  console.log(`[batch] ${totalProcessed}/${totalWork} (${pct}%) — updated: ${totalUpdated}, skipped: ${totalSkipped}, errors: ${totalErrors}`)

  // Check limit
  if (LIMIT > 0 && totalProcessed >= LIMIT) {
    console.log(`[batch] limit reached (${LIMIT})`)
    break
  }
}

console.log(`[batch] COMPLETE — processed: ${totalProcessed}, updated: ${totalUpdated}, skipped: ${totalSkipped}, errors: ${totalErrors}`)

if (totalErrors === 0 && !DRY_RUN) {
  clearCheckpoint()
  console.log('[batch] checkpoint cleared (clean run)')
}

await client.end()
process.exit(totalErrors > 0 ? 1 : 0)
