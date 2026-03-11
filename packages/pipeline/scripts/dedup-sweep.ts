#!/usr/bin/env bun
/**
 * Phase 7.1 — Two-tier dedup sweep
 * Tier 1: Exact match on (subject, predicate) — keep newest, expire older
 * Tier 2: Fuzzy match on object_val via Jaccard trigram similarity >0.85
 *
 * Usage: bun run scripts/dedup-sweep.ts [--dry-run]
 */

import postgres from 'postgres'

const DRY_RUN = process.argv.includes('--dry-run')
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://locigram:388d3ec5561e2d52726d6cea30c39518732c657ee1fb07b4@10.10.100.90:30311/locigram'

const sql = postgres(DB_URL, { max: 5 })

function wordTrigrams(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0)
  const trigrams = new Set<string>()
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  }
  return trigrams
}

function jaccard(a: Set<string>, b: Set<string>): number {
  // Both empty = not comparable (need at least some content to judge similarity)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) { if (b.has(item)) intersection++ }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

async function main() {
  console.log(`[dedup] Phase 7.1 — two-tier dedup sweep (dry_run=${DRY_RUN})`)

  // ── Tier 1: Exact SPO match ──
  // Find groups with same (subject, predicate) that have >1 active record
  const dupeGroups = await sql`
    SELECT subject, predicate, COUNT(*) as cnt,
           array_agg(id ORDER BY created_at DESC) as ids,
           array_agg(LEFT(content, 80) ORDER BY created_at DESC) as snippets
    FROM locigrams
    WHERE expires_at IS NULL AND subject IS NOT NULL AND predicate IS NOT NULL
    GROUP BY subject, predicate
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `

  let tier1Expired = 0
  for (const group of dupeGroups) {
    const { subject, predicate, ids, snippets } = group
    // Keep the first (newest), expire the rest
    const toExpire = ids.slice(1)
    console.log(`[dedup:t1] ${subject}/${predicate} — keeping ${ids[0].slice(0,8)}, expiring ${toExpire.length}`)
    for (let i = 0; i < toExpire.length && i < 3; i++) {
      console.log(`  └ expire: ${snippets[i + 1]?.slice(0, 60)}`)
    }
    if (!DRY_RUN) {
      await sql`UPDATE locigrams SET expires_at = NOW() WHERE id = ANY(${toExpire})`
    }
    tier1Expired += toExpire.length
  }

  console.log(`[dedup:t1] DONE: ${tier1Expired} expired from ${dupeGroups.length} groups`)

  // ── Tier 2: Fuzzy object_val match ──
  // Load all active structured memories and check pairwise within same category
  const structured = await sql`
    SELECT id, subject, predicate, object_val, category, content, created_at
    FROM locigrams
    WHERE expires_at IS NULL AND subject IS NOT NULL AND object_val IS NOT NULL
    ORDER BY category, created_at DESC
  `

  let tier2Expired = 0
  const expired = new Set<string>()

  // Group by category for efficiency
  const byCategory = new Map<string, typeof structured>()
  for (const row of structured) {
    const cat = row.category as string
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(row)
  }

  for (const [cat, rows] of byCategory) {
    const trigrams = rows.map(r => wordTrigrams(r.object_val as string))

    for (let i = 0; i < rows.length; i++) {
      if (expired.has(rows[i].id as string)) continue
      for (let j = i + 1; j < rows.length; j++) {
        if (expired.has(rows[j].id as string)) continue
        const sim = jaccard(trigrams[i], trigrams[j])
        if (sim > 0.85) {
          // Expire the older one (j, since sorted newest first)
          console.log(`[dedup:t2] sim=${sim.toFixed(2)} — keep ${(rows[i].id as string).slice(0,8)} expire ${(rows[j].id as string).slice(0,8)}`)
          console.log(`  keep:   ${(rows[i].content as string).slice(0, 60)}`)
          console.log(`  expire: ${(rows[j].content as string).slice(0, 60)}`)
          if (!DRY_RUN) {
            await sql`UPDATE locigrams SET expires_at = NOW() WHERE id = ${rows[j].id}`
          }
          expired.add(rows[j].id as string)
          tier2Expired++
        }
      }
    }
  }

  console.log(`[dedup:t2] DONE: ${tier2Expired} expired via fuzzy match`)
  console.log(`[dedup] TOTAL: ${tier1Expired + tier2Expired} duplicates expired`)

  await sql.end()
}

main().catch(e => { console.error('[dedup] fatal:', e); process.exit(1) })
