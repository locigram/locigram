import { locigrams, retrievalEvents } from '@locigram/db'
import { eq, and, sql, gte } from 'drizzle-orm'
import type { DB } from '@locigram/db'

const MIN_COOCCURRENCE  = parseInt(process.env.LOCIGRAM_CLUSTER_MIN_COOCCURRENCE ?? '5')
const WINDOW_DAYS       = parseInt(process.env.LOCIGRAM_CLUSTER_WINDOW_DAYS      ?? '30')

export async function runClusterAnalysis(db: DB, palaceId: string): Promise<void> {
  console.log(`[cluster][${palaceId}] starting co-occurrence analysis`)

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // Pairwise co-occurrence: unnest locigram_ids pairs from retrieval_events
  // Count how often each pair appears together in queries
  const pairs = await db.execute(sql`
    SELECT
      a.locigram_id AS id_a,
      b.locigram_id AS id_b,
      COUNT(*)::int  AS co_count
    FROM retrieval_events re,
         LATERAL unnest(re.locigram_ids) AS a(locigram_id),
         LATERAL unnest(re.locigram_ids) AS b(locigram_id)
    WHERE re.palace_id = ${palaceId}
      AND re.retrieved_at >= ${since}
      AND a.locigram_id < b.locigram_id   -- deduplicate pairs (a < b alphabetically)
    GROUP BY a.locigram_id, b.locigram_id
    HAVING COUNT(*) >= ${MIN_COOCCURRENCE}
    ORDER BY co_count DESC
    LIMIT 500
  `) as Array<{ id_a: string; id_b: string; co_count: number }>

  if (pairs.length === 0) {
    console.log(`[cluster][${palaceId}] no pairs above threshold`)
    return
  }

  // Collect all IDs that appear in qualifying pairs
  const candidateIds = new Set<string>()
  for (const p of pairs) {
    candidateIds.add(p.id_a)
    candidateIds.add(p.id_b)
  }

  // Flag all candidates
  await db.execute(sql`
    UPDATE locigrams
    SET cluster_candidate = TRUE
    WHERE palace_id = ${palaceId}
      AND id = ANY(${[...candidateIds]}::uuid[])
      AND is_reference = FALSE
      AND tier != 'cold'
  `)

  console.log(`[cluster][${palaceId}] flagged ${candidateIds.size} candidates from ${pairs.length} qualifying pairs`)
}

// Standalone entry point (for K8s CronJob)
if (import.meta.main) {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL required')
  const palaceId = process.env.PALACE_ID ?? 'main'

  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const schema = await import('@locigram/db')

  const client = postgres(dbUrl, { max: 5 })
  const db = drizzle(client, { schema: schema as any })

  await runClusterAnalysis(db, palaceId)
  await client.end()
  process.exit(0)
}
