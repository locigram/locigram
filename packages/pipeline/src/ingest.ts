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

// Minimum extraction confidence — locigrams below this are noise and not stored
const MIN_CONFIDENCE = 0.3

// Normalize importance values from different connectors to low|normal|high
function normalizeImportance(raw?: string): string {
  if (!raw) return 'normal'
  const v = raw.toLowerCase()
  if (v === 'high' || v === 'urgent' || v === 'critical' || v === '1') return 'high'
  if (v === 'low' || v === '3')   return 'low'
  return 'normal'
}

export async function ingest(
  rawMemories: RawMemory[],
  db: DB,
  config: PipelineConfig,
): Promise<IngestResult> {
  const result: IngestResult = { stored: 0, skipped: 0, errors: [] }

  for (const raw of rawMemories) {
    try {
      // 1. Dedup check — skip if sourceRef already exists for this palace
      if (await isDuplicate(db, config.palaceId, raw.sourceRef)) {
        result.skipped++
        continue
      }

      // 2. Extract locigrams + entities from raw text
      const extraction = await extractFromRaw(raw, config)

      // 3. Resolve entities (match or create in DB)
      const resolvedEntities = await resolveEntities(db, config.palaceId, extraction.entities)

      // 4. Derive connector name from metadata (set by connector plugin)
      const connector = (raw.metadata?.connector as string | undefined) ?? raw.sourceType

      // 5. Store each extracted locigram — skip low-confidence noise
      let storedAny = false
      for (const loc of extraction.locigrams) {
        if (loc.confidence < MIN_CONFIDENCE) {
          result.skipped++
          continue
        }

        const [stored] = await db.insert(locigrams).values({
          content:       loc.content,
          sourceType:    raw.sourceType,
          sourceRef:     raw.sourceRef,
          connector,
          occurredAt:    raw.occurredAt ?? null,
          locus:         extraction.locus,
          clientId:      (raw.metadata?.client_id as string | undefined) ?? null,
          importance:    normalizeImportance(raw.metadata?.importance as string | undefined),
          tier:          'hot',
          isReference:   extraction.isReference ?? false,
          referenceType: extraction.referenceType ?? null,
          entities:      resolvedEntities,
          confidence:    loc.confidence,
          metadata:      raw.metadata ?? {},
          palaceId:      config.palaceId,
        }).returning()

        // 6. Store provenance in sources table
        await db.insert(sources).values({
          locigramId: stored.id,
          connector,
          rawRef:     raw.sourceRef,
          palaceId:   config.palaceId,
        })

        result.stored++
        storedAny = true
      }

      // Count the whole raw as skipped if nothing made it through
      if (!storedAny && extraction.locigrams.length > 0) {
        result.skipped++
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`[${raw.sourceRef ?? 'unknown'}] ${msg}`)
      console.error('[pipeline] ingest error:', msg)
    }
  }

  return result
}
