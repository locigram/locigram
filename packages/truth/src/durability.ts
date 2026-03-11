/**
 * Durability Lifecycle Engine — Phase 4
 *
 * Manages memory lifecycle based on durability_class:
 * - TTL enforcement: set expires_at based on class + last access
 * - Supersession: same subject+predicate → mark old as superseded
 * - Promotion: active → stable after sustained relevance
 * - Demotion: session → expired on TTL
 *
 * Designed to run alongside the existing sweep (tier-based decay).
 * Called from the same K8s CronJob or in-process interval.
 */

import { sql } from 'drizzle-orm'
import type { DB } from '@locigram/db'

// ── TTL Configuration ────────────────────────────────────────────────────────

interface TTLConfig {
  /** Session memories expire after this many hours (default: 24) */
  sessionHours: number
  /** Checkpoint memories expire after this many hours (default: 72) */
  checkpointHours: number
  /** Active memories expire after this many days without access (default: 21) */
  activeDays: number
  /** Stable memories expire after this many days without access (default: 180) */
  stableDays: number
  /** Minimum access count to promote active → stable (default: 5) */
  promotionMinAccess: number
  /** Minimum age in days before active → stable promotion (default: 14) */
  promotionMinAgeDays: number
}

function loadConfig(): TTLConfig {
  return {
    sessionHours:       parseInt(process.env.LOCIGRAM_TTL_SESSION_HOURS ?? '24'),
    checkpointHours:    parseInt(process.env.LOCIGRAM_TTL_CHECKPOINT_HOURS ?? '72'),
    activeDays:         parseInt(process.env.LOCIGRAM_TTL_ACTIVE_DAYS ?? '21'),
    stableDays:         parseInt(process.env.LOCIGRAM_TTL_STABLE_DAYS ?? '180'),
    promotionMinAccess: parseInt(process.env.LOCIGRAM_PROMOTION_MIN_ACCESS ?? '5'),
    promotionMinAgeDays: parseInt(process.env.LOCIGRAM_PROMOTION_MIN_AGE_DAYS ?? '14'),
  }
}

export interface DurabilityResult {
  sessionsExpired: number
  checkpointsExpired: number
  activeExpired: number
  staleStableExpired: number
  superseded: number
  promoted: number
}

/**
 * Run the full durability lifecycle for a palace.
 * Safe to run frequently — all operations are idempotent.
 */
export async function runDurabilityLifecycle(db: DB, palaceId: string): Promise<DurabilityResult> {
  const cfg = loadConfig()
  console.log(`[durability][${palaceId}] starting lifecycle sweep`)

  const result: DurabilityResult = {
    sessionsExpired: 0,
    checkpointsExpired: 0,
    activeExpired: 0,
    staleStableExpired: 0,
    superseded: 0,
    promoted: 0,
  }

  // ── 1. TTL: Expire session memories ────────────────────────────────────────
  // Session memories that haven't been accessed within sessionHours
  const sessionResult = await db.execute(sql`
    UPDATE locigrams
    SET expires_at = NOW()
    WHERE palace_id = ${palaceId}
      AND durability_class = 'session'
      AND expires_at IS NULL
      AND COALESCE(last_accessed_at, created_at) < NOW() - INTERVAL '1 hour' * ${cfg.sessionHours}
    RETURNING id
  `) as Array<{ id: string }>
  result.sessionsExpired = sessionResult.length

  // ── 2. TTL: Expire stale checkpoints ───────────────────────────────────────
  const checkpointResult = await db.execute(sql`
    UPDATE locigrams
    SET expires_at = NOW()
    WHERE palace_id = ${palaceId}
      AND durability_class = 'checkpoint'
      AND expires_at IS NULL
      AND COALESCE(last_accessed_at, created_at) < NOW() - INTERVAL '1 hour' * ${cfg.checkpointHours}
    RETURNING id
  `) as Array<{ id: string }>
  result.checkpointsExpired = checkpointResult.length

  // ── 3. TTL: Expire stale active memories ───────────────────────────────────
  // Active memories not accessed within activeDays AND not superseded
  const activeResult = await db.execute(sql`
    UPDATE locigrams
    SET expires_at = NOW()
    WHERE palace_id = ${palaceId}
      AND durability_class = 'active'
      AND expires_at IS NULL
      AND superseded_by IS NULL
      AND COALESCE(last_accessed_at, created_at) < NOW() - INTERVAL '1 day' * ${cfg.activeDays}
    RETURNING id
  `) as Array<{ id: string }>
  result.activeExpired = activeResult.length

  // ── 4. TTL: Expire very stale stable memories ─────────────────────────────
  // Stable memories not accessed within stableDays
  const stableResult = await db.execute(sql`
    UPDATE locigrams
    SET expires_at = NOW()
    WHERE palace_id = ${palaceId}
      AND durability_class = 'stable'
      AND expires_at IS NULL
      AND superseded_by IS NULL
      AND COALESCE(last_accessed_at, created_at) < NOW() - INTERVAL '1 day' * ${cfg.stableDays}
    RETURNING id
  `) as Array<{ id: string }>
  result.staleStableExpired = stableResult.length

  // ── 5. Supersession: same subject+predicate → mark old as superseded ───────
  // When multiple active (non-expired) locigrams share the same subject+predicate,
  // keep only the newest, supersede the rest.
  const supersededResult = await db.execute(sql`
    WITH ranked AS (
      SELECT
        id,
        subject,
        predicate,
        ROW_NUMBER() OVER (
          PARTITION BY palace_id, subject, predicate
          ORDER BY created_at DESC
        ) AS rn,
        FIRST_VALUE(id) OVER (
          PARTITION BY palace_id, subject, predicate
          ORDER BY created_at DESC
        ) AS newest_id
      FROM locigrams
      WHERE palace_id = ${palaceId}
        AND subject IS NOT NULL
        AND predicate IS NOT NULL
        AND expires_at IS NULL
        AND superseded_by IS NULL
    )
    UPDATE locigrams l
    SET
      superseded_by = r.newest_id,
      expires_at = NOW()
    FROM ranked r
    WHERE l.id = r.id
      AND r.rn > 1
    RETURNING l.id
  `) as Array<{ id: string }>
  result.superseded = supersededResult.length

  // ── 6. Promotion: active → stable after sustained relevance ────────────────
  // Criteria: accessed at least N times, older than M days, still active
  const promotedResult = await db.execute(sql`
    UPDATE locigrams
    SET durability_class = 'stable'
    WHERE palace_id = ${palaceId}
      AND durability_class = 'active'
      AND expires_at IS NULL
      AND superseded_by IS NULL
      AND access_count >= ${cfg.promotionMinAccess}
      AND created_at < NOW() - INTERVAL '1 day' * ${cfg.promotionMinAgeDays}
    RETURNING id
  `) as Array<{ id: string }>
  result.promoted = promotedResult.length

  console.log(
    `[durability][${palaceId}] done — ` +
    `sessions: ${result.sessionsExpired}, ` +
    `checkpoints: ${result.checkpointsExpired}, ` +
    `active: ${result.activeExpired}, ` +
    `stable: ${result.staleStableExpired}, ` +
    `superseded: ${result.superseded}, ` +
    `promoted: ${result.promoted}`
  )

  return result
}

// Standalone entry point (for K8s CronJob or CLI)
if (import.meta.main) {
  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const schema = await import('@locigram/db')

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL required')
  const palaceId = process.env.PALACE_ID ?? 'main'

  const client = postgres(dbUrl, { max: 5 })
  const db = drizzle(client, { schema })

  const result = await runDurabilityLifecycle(db, palaceId)
  console.log(JSON.stringify(result, null, 2))

  await client.end()
  process.exit(0)
}
