import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '@locigram/db'
import { locigrams } from '@locigram/db'
import { eq, and, lt, inArray, sql } from 'drizzle-orm'
import type { DB } from '@locigram/db'

const DECAY_FACTOR         = parseFloat(process.env.LOCIGRAM_DECAY_FACTOR          ?? '0.6')
const HOT_THRESHOLD        = parseFloat(process.env.LOCIGRAM_DECAY_HOT_THRESHOLD   ?? '0.3')
const WARM_THRESHOLD       = parseFloat(process.env.LOCIGRAM_DECAY_WARM_THRESHOLD  ?? '0.1')
const NOISE_THRESHOLD      = parseFloat(process.env.LOCIGRAM_DECAY_NOISE_THRESHOLD ?? '0.05')

export async function runSweep(db: DB, palaceId: string): Promise<void> {
  console.log(`[sweep][${palaceId}] starting decay sweep`)
  const now = Date.now()

  // Fetch all hot + warm knowledge locigrams (skip is_reference — they never decay)
  const candidates = await db
    .select()
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palaceId),
        eq(locigrams.isReference, false),
        inArray(locigrams.tier, ['hot', 'warm']),
      )
    )

  let demotedToWarm = 0
  let demotedToCold = 0
  let queuedForAssess = 0

  for (const loc of candidates) {
    // Compute days since last access (use created_at if never accessed)
    const lastActivity = loc.lastAccessedAt ?? loc.createdAt
    const daysSince = (now - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)

    // Inverse power-law decay: access_score = access_count / (days + 1) ^ λ
    const newScore = loc.accessCount / Math.pow(daysSince + 1, DECAY_FACTOR)

    let newTier = loc.tier

    if (loc.tier === 'hot' && newScore < HOT_THRESHOLD) {
      newTier = 'warm'
      demotedToWarm++
    } else if (loc.tier === 'warm' && newScore < WARM_THRESHOLD) {
      newTier = 'cold'
      demotedToCold++
    }

    await db.update(locigrams)
      .set({ accessScore: newScore, tier: newTier })
      .where(eq(locigrams.id, loc.id))
  }

  // Queue cold + very-low-score locigrams for noise re-assessment
  const coldNoise = await db
    .select({ id: locigrams.id })
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palaceId),
        eq(locigrams.tier, 'cold'),
        eq(locigrams.isReference, false),
        lt(locigrams.accessScore, NOISE_THRESHOLD),
        sql`expires_at IS NULL`,  // not already expired
      )
    )

  // Mark as queued for assessment by setting metadata flag
  if (coldNoise.length > 0) {
    const ids = coldNoise.map(r => r.id)
    await db.update(locigrams)
      .set({ metadata: sql`metadata || '{"assess_queued": true}'::jsonb` })
      .where(and(eq(locigrams.palaceId, palaceId), inArray(locigrams.id, ids)))
    queuedForAssess = ids.length
  }

  console.log(`[sweep][${palaceId}] done — hot→warm: ${demotedToWarm}, warm→cold: ${demotedToCold}, queued for assess: ${queuedForAssess}`)
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
