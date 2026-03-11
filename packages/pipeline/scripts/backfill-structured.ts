#!/usr/bin/env bun
/**
 * Phase 6 — Backfill structured fields (subject/predicate/object_val/durability_class/category)
 * for existing locigrams that were ingested before the extraction pipeline.
 *
 * Usage: bun run scripts/backfill-structured.ts [--batch-size 20] [--limit 100] [--dry-run]
 */

import { eq, and, isNull, sql, gte } from 'drizzle-orm'
import { createDb, locigrams } from '../../db/src/client'
import { extractFromRaw } from '../src/extract'
import type { PipelineConfig } from '../src/config'

// ── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch-size='))?.split('=')[1] ?? '20')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '0') || Infinity
const DRY_RUN = process.argv.includes('--dry-run')

const DB_URL = process.env.LOCIGRAM_DATABASE_URL ?? process.env.DATABASE_URL
if (!DB_URL) {
  console.error('Set LOCIGRAM_DATABASE_URL or DATABASE_URL')
  process.exit(1)
}

const LLM_URL = process.env.LLM_URL ?? 'http://10.10.100.82:30891/v1'
const LLM_MODEL = process.env.LLM_MODEL ?? 'vllm'
const LLM_KEY = process.env.LLM_API_KEY

// ── DB ───────────────────────────────────────────────────────────────────────

const db = createDb(DB_URL)

const llmRole = { url: LLM_URL, model: LLM_MODEL, ...(LLM_KEY ? { apiKey: LLM_KEY } : {}), noThink: true }
const pipelineConfig: PipelineConfig = {
  palaceId: 'main',
  llm: {
    embed:   { url: 'http://10.10.100.82:30888', model: 'vllm' },  // not used in extraction
    extract: llmRole,
    summary: llmRole,
  },
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backfill] Starting structured extraction backfill`)
  console.log(`[backfill] batch_size=${BATCH_SIZE} limit=${LIMIT === Infinity ? 'all' : LIMIT} dry_run=${DRY_RUN}`)

  let processed = 0
  let updated = 0
  let skipped = 0
  let errors = 0

  while (processed < LIMIT) {
    // Fetch batch of unstructured memories
    const batch = await db.select({
      id: locigrams.id,
      content: locigrams.content,
      sourceType: locigrams.sourceType,
      sourceRef: locigrams.sourceRef,
      locus: locigrams.locus,
      connector: locigrams.connector,
      metadata: locigrams.metadata,
      category: locigrams.category,
      durabilityClass: locigrams.durabilityClass,
    })
      .from(locigrams)
      .where(and(
        isNull(locigrams.expiresAt),
        isNull(locigrams.subject),
        sql`LENGTH(${locigrams.content}) >= 50`,
        // Skip JSON blobs and CoT leaks
        sql`${locigrams.content} NOT LIKE '{%'`,
        sql`${locigrams.content} NOT LIKE 'Thinking Process%'`,
      ))
      .orderBy(locigrams.createdAt)
      .limit(Math.min(BATCH_SIZE, LIMIT - processed))

    if (batch.length === 0) {
      console.log(`[backfill] No more records to process`)
      break
    }

    for (const row of batch) {
      processed++

      try {
        const raw = {
          content: row.content,
          sourceType: row.sourceType as any,
          sourceRef: row.sourceRef ?? undefined,
          metadata: (row.metadata as Record<string, unknown>) ?? {},
        }

        const result = await extractFromRaw(raw, pipelineConfig)

        // Take the first locigram extraction result
        const loc = result.locigrams[0]
        if (!loc || (!loc.subject && !loc.predicate)) {
          skipped++
          if (processed % 50 === 0) console.log(`[backfill] progress: ${processed} processed, ${updated} updated, ${skipped} skipped, ${errors} errors`)
          continue
        }

        if (DRY_RUN) {
          console.log(`[backfill][dry] ${row.id}: subject=${loc.subject} predicate=${loc.predicate} category=${loc.category} durability=${loc.durability_class}`)
          updated++
          continue
        }

        // Update the record with extracted structured fields
        await db.update(locigrams)
          .set({
            subject: loc.subject ?? null,
            predicate: loc.predicate ?? null,
            objectVal: loc.object_val ?? null,
            category: loc.category ?? row.category,
            durabilityClass: loc.durability_class ?? row.durabilityClass,
          })
          .where(eq(locigrams.id, row.id))

        updated++
      } catch (e: any) {
        errors++
        console.warn(`[backfill] error on ${row.id}: ${e.message}`)
      }

      // Rate limit: ~1 req/sec to not overwhelm the LLM
      if (processed % 5 === 0) {
        await new Promise(r => setTimeout(r, 500))
      }

      if (processed % 50 === 0) {
        console.log(`[backfill] progress: ${processed} processed, ${updated} updated, ${skipped} skipped, ${errors} errors`)
      }
    }
  }

  console.log(`[backfill] DONE: ${processed} processed, ${updated} updated, ${skipped} skipped, ${errors} errors`)
  process.exit(0)
}

main().catch(e => {
  console.error('[backfill] fatal:', e)
  process.exit(1)
})
