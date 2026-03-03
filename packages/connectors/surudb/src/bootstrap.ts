import type { DB } from '@locigram/db'
import type { PipelineConfig } from '@locigram/pipeline'
import { ingest } from '@locigram/pipeline'
import { createSuruDbConnector } from './plugin'
import type { SuruDbConnectorConfig } from './plugin'

export interface BootstrapOptions {
  batchSize?: number    // records per batch (default 100)
  since?:     Date      // only pull records after this date
  dryRun?:    boolean   // extract + log but don't store
}

/**
 * One-shot bootstrap: pull all suru DB data into the palace.
 * Run this once on first deploy to seed the palace with existing knowledge.
 */
export async function bootstrapFromSuruDb(
  connectorConfig: SuruDbConnectorConfig,
  db:              DB,
  pipelineConfig:  PipelineConfig,
  opts:            BootstrapOptions = {},
): Promise<{ total: number; stored: number; skipped: number; errors: string[] }> {
  const { batchSize = 100, since, dryRun = false } = opts

  console.log(`[surudb-bootstrap] pulling from suru DB${since ? ` since ${since.toISOString()}` : ' (full history)'}`)

  const connector = createSuruDbConnector(connectorConfig)
  const all       = await connector.pull(since)

  console.log(`[surudb-bootstrap] pulled ${all.length} raw memories`)

  if (dryRun) {
    console.log('[surudb-bootstrap] dry run — no storage')
    return { total: all.length, stored: 0, skipped: all.length, errors: [] }
  }

  let stored  = 0
  let skipped = 0
  const errors: string[] = []

  // Process in batches to avoid overwhelming the LLM extraction endpoint
  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize)
    console.log(`[surudb-bootstrap] ingesting batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(all.length / batchSize)}`)

    const result = await ingest(batch, db, pipelineConfig)
    stored  += result.stored
    skipped += result.skipped
    errors.push(...result.errors)
  }

  console.log(`[surudb-bootstrap] done — stored: ${stored}, skipped: ${skipped}, errors: ${errors.length}`)
  return { total: all.length, stored, skipped, errors }
}
