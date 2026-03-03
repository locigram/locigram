import { locigrams, sources } from '@locigram/db'
import type { DB } from '@locigram/db'
import type { RawMemory } from '@locigram/core'
import type { PipelineConfig } from './config'
import { extractFromRaw } from './extract'
import { resolveEntities } from './resolve'
import { isDuplicate } from './dedup'

export interface IngestResult {
  stored:  number
  skipped: number
  errors:  string[]
}

export async function ingest(
  rawMemories: RawMemory[],
  db: DB,
  config: PipelineConfig,
): Promise<IngestResult> {
  const result: IngestResult = { stored: 0, skipped: 0, errors: [] }

  for (const raw of rawMemories) {
    try {
      // 1. Dedup check
      if (await isDuplicate(db, config.palaceId, raw.sourceRef)) {
        result.skipped++
        continue
      }

      // 2. Extract locigrams + entities from raw text
      const extraction = await extractFromRaw(raw, config)

      // 3. Resolve entities (match or create in DB)
      const resolvedEntities = await resolveEntities(db, config.palaceId, extraction.entities)

      // 4. Store each extracted locigram
      for (const loc of extraction.locigrams) {
        const [stored] = await db.insert(locigrams).values({
          content:    loc.content,
          sourceType: raw.sourceType,
          sourceRef:  raw.sourceRef,
          locus:      extraction.locus,
          entities:   resolvedEntities,
          confidence: loc.confidence,
          metadata:   raw.metadata ?? {},
          palaceId:   config.palaceId,
        }).returning()

        // 5. Store provenance
        await db.insert(sources).values({
          locigramId: stored.id,
          connector:  raw.metadata?.connector as string ?? raw.sourceType,
          rawRef:     raw.sourceRef,
          palaceId:   config.palaceId,
        })

        result.stored++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`[${raw.sourceRef ?? 'unknown'}] ${msg}`)
      console.error('[pipeline] ingest error:', msg)
    }
  }

  return result
}
