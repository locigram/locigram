/**
 * One-shot migration: populates Memgraph from existing Postgres locigrams.
 * Usage: MEMGRAPH_URL=bolt://10.10.100.80:30313 DATABASE_URL=<url> bun run packages/server/src/graph/migrate-to-graph.ts
 */
import { createDb, locigrams } from '@locigram/db'
import { writeMemoryToGraph, parseAgentFromLocus } from './graph-write'
import { getGraphDriver } from './graph-client'

async function migrate() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL required')
  if (!process.env.MEMGRAPH_URL) throw new Error('MEMGRAPH_URL required')

  const db = createDb(dbUrl)
  const records = await db.select().from(locigrams).limit(10000)
  console.log(`Migrating ${records.length} records to Memgraph...`)

  let success = 0, failed = 0
  for (const r of records) {
    try {
      await writeMemoryToGraph({
        id: r.id,
        palaceId: r.palaceId,
        locus: r.locus ?? 'unknown',
        sourceType: r.sourceType,
        agentName: parseAgentFromLocus(r.locus ?? ''),
        sessionId: (r.metadata as any)?.session_id ?? (r.metadata as any)?.sessionId ?? undefined,
        importance: r.importance,
        occurredAt: r.occurredAt ?? r.createdAt,
        connector: r.connector,
      })
      success++
      if (success % 50 === 0) console.log(`  ${success}/${records.length}...`)
    } catch (e) {
      failed++
      console.warn(`  Failed to migrate ${r.id}:`, e)
    }
  }

  console.log(`\nMigration complete: ${success} success, ${failed} failed`)
  await getGraphDriver()?.close()
  process.exit(0)
}

migrate().catch(e => { console.error(e); process.exit(1) })
