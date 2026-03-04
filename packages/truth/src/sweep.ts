import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '@locigram/db'
import { sql } from 'drizzle-orm'
import type { DB } from '@locigram/db'

const DECAY_FACTOR    = parseFloat(process.env.LOCIGRAM_DECAY_FACTOR          ?? '0.6')
const HOT_THRESHOLD   = parseFloat(process.env.LOCIGRAM_DECAY_HOT_THRESHOLD   ?? '0.3')
const WARM_THRESHOLD  = parseFloat(process.env.LOCIGRAM_DECAY_WARM_THRESHOLD  ?? '0.1')
const NOISE_THRESHOLD = parseFloat(process.env.LOCIGRAM_DECAY_NOISE_THRESHOLD ?? '0.05')

export async function runSweep(db: DB, palaceId: string): Promise<void> {
  console.log(`[sweep][${palaceId}] starting decay sweep`)

  // ── Single bulk UPDATE — no row loop, no memory pressure ──────────────────
  //
  // Formula: access_score = access_count / (days_since_last_access + 1) ^ λ
  //
  // Uses a CTE to compute new scores first, then joins back to update.
  // One roundtrip to Postgres regardless of table size.
  //
  const result = await db.execute(sql`
    WITH scored AS (
      SELECT
        id,
        tier,
        access_count::float /
          POWER(
            EXTRACT(EPOCH FROM (
              NOW() - COALESCE(last_accessed_at, created_at)
            )) / 86400.0 + 1,
            ${DECAY_FACTOR}
          ) AS new_score
      FROM locigrams
      WHERE palace_id  = ${palaceId}
        AND is_reference = FALSE
        AND tier IN ('hot', 'warm')
        AND expires_at IS NULL
    )
    UPDATE locigrams l
    SET
      access_score = s.new_score,
      tier = CASE
        WHEN l.tier = 'hot'  AND s.new_score < ${HOT_THRESHOLD}  THEN 'warm'
        WHEN l.tier = 'warm' AND s.new_score < ${WARM_THRESHOLD} THEN 'cold'
        ELSE l.tier
      END
    FROM scored s
    WHERE l.id = s.id
    RETURNING
      l.id,
      l.tier                                                    AS new_tier,
      (l.tier != CASE
        WHEN s.tier = 'hot'  AND s.new_score < ${HOT_THRESHOLD}  THEN 'warm'
        WHEN s.tier = 'warm' AND s.new_score < ${WARM_THRESHOLD} THEN 'cold'
        ELSE s.tier
       END)                                                     AS tier_changed,
      s.tier                                                    AS old_tier
  `) as Array<{ id: string; new_tier: string; tier_changed: boolean; old_tier: string }>

  const demotedToWarm = result.filter(r => r.tier_changed && r.new_tier === 'warm').length
  const demotedToCold = result.filter(r => r.tier_changed && r.new_tier === 'cold').length

  // ── Queue cold + very-low-score locigrams for noise re-assessment ──────────
  //
  // Single UPDATE — sets metadata flag on eligible cold locigrams.
  // Skips already-queued rows (metadata->>'assess_queued' IS NULL guard).
  //
  const noiseResult = await db.execute(sql`
    UPDATE locigrams
    SET metadata = metadata || '{"assess_queued": true}'::jsonb
    WHERE palace_id    = ${palaceId}
      AND tier         = 'cold'
      AND is_reference = FALSE
      AND access_score < ${NOISE_THRESHOLD}
      AND expires_at   IS NULL
      AND (metadata->>'assess_queued') IS NULL
    RETURNING id
  `) as Array<{ id: string }>

  const queuedForAssess = noiseResult.length

  console.log(
    `[sweep][${palaceId}] done — ` +
    `updated: ${result.length}, ` +
    `hot→warm: ${demotedToWarm}, ` +
    `warm→cold: ${demotedToCold}, ` +
    `queued for assess: ${queuedForAssess}`
  )
}

// Standalone entry point (for K8s CronJob)
if (import.meta.main) {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL required')
  const palaceId = process.env.PALACE_ID ?? 'main'

  const client = postgres(dbUrl, { max: 5 })
  const db = drizzle(client, { schema })

  await runSweep(db, palaceId)
  await client.end()
  process.exit(0)
}
