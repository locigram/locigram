/**
 * Two-tier dedup sweep — callable from maintenance scheduler or standalone script
 *
 * Tier 1: Exact match on (subject, predicate) — keep highest confidence, expire rest
 * Tier 2: Fuzzy match on object_val via Jaccard trigram similarity >0.85
 */

import { sql } from 'drizzle-orm'
import type { DB } from '@locigram/db'

function wordTrigrams(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0)
  const trigrams = new Set<string>()
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  }
  return trigrams
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) { if (b.has(item)) intersection++ }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

export interface DedupResult {
  tier1Expired: number
  tier1Groups: number
  tier2Expired: number
  total: number
}

export async function runDedup(db: DB, palaceId: string, dryRun = false): Promise<DedupResult> {
  console.log(`[dedup][${palaceId}] two-tier dedup sweep (dry_run=${dryRun})`)

  // ── Tier 1: Exact SPO match ──
  // Prefer: highest confidence → has SPO object_val → newest
  const dupeGroups = await db.execute(sql`
    SELECT subject, predicate, COUNT(*) as cnt,
           array_agg(id ORDER BY
             confidence DESC NULLS LAST,
             (CASE WHEN object_val IS NOT NULL THEN 0 ELSE 1 END),
             created_at DESC
           ) as ids
    FROM locigrams
    WHERE palace_id = ${palaceId}
      AND expires_at IS NULL
      AND subject IS NOT NULL
      AND predicate IS NOT NULL
    GROUP BY subject, predicate
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `) as Array<{ subject: string; predicate: string; cnt: number; ids: string[] }>

  let tier1Expired = 0
  for (const group of dupeGroups) {
    const toExpire = group.ids.slice(1)
    console.log(`[dedup:t1] ${group.subject}/${group.predicate} — keeping ${group.ids[0].slice(0,8)}, expiring ${toExpire.length}`)
    if (!dryRun && toExpire.length > 0) {
      await db.execute(sql`UPDATE locigrams SET expires_at = NOW() WHERE id = ANY(${toExpire}::uuid[])`)
    }
    tier1Expired += toExpire.length
  }

  console.log(`[dedup:t1][${palaceId}] DONE: ${tier1Expired} expired from ${dupeGroups.length} groups`)

  // ── Tier 2: Fuzzy object_val match ──
  const structured = await db.execute(sql`
    SELECT id, subject, predicate, object_val, category, content, created_at
    FROM locigrams
    WHERE palace_id = ${palaceId}
      AND expires_at IS NULL
      AND subject IS NOT NULL
      AND object_val IS NOT NULL
    ORDER BY category, created_at DESC
  `) as Array<{ id: string; subject: string; predicate: string; object_val: string; category: string; content: string; created_at: Date }>

  let tier2Expired = 0
  const expired = new Set<string>()

  const byCategory = new Map<string, typeof structured>()
  for (const row of structured) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, [])
    byCategory.get(row.category)!.push(row)
  }

  for (const [, rows] of byCategory) {
    const trigrams = rows.map(r => wordTrigrams(r.object_val))

    for (let i = 0; i < rows.length; i++) {
      if (expired.has(rows[i].id)) continue
      for (let j = i + 1; j < rows.length; j++) {
        if (expired.has(rows[j].id)) continue
        if (rows[i].subject !== rows[j].subject) continue
        const sim = jaccard(trigrams[i], trigrams[j])
        if (sim > 0.85) {
          console.log(`[dedup:t2] sim=${sim.toFixed(2)} — keep ${rows[i].id.slice(0,8)} expire ${rows[j].id.slice(0,8)}`)
          if (!dryRun) {
            await db.execute(sql`UPDATE locigrams SET expires_at = NOW() WHERE id = ${rows[j].id}::uuid`)
          }
          expired.add(rows[j].id)
          tier2Expired++
        }
      }
    }
  }

  const total = tier1Expired + tier2Expired
  console.log(`[dedup][${palaceId}] DONE: ${total} total expired (t1=${tier1Expired}, t2=${tier2Expired})`)

  return { tier1Expired, tier1Groups: dupeGroups.length, tier2Expired, total }
}
