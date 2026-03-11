/**
 * Entity mention storage — writes GLiNER and LLM entity detections
 * to the entity_mentions table for audit trail + type voting.
 *
 * Phase 9.1-9.2
 */

import { entityMentions, entities as entitiesTable } from '@locigram/db'
import { eq, and, sql } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import type { GLiNERMention } from './gliner'
import type { ExtractionResult } from './extract'

export interface MentionInput {
  locigramId: string
  palaceId:   string
}

/**
 * Store GLiNER mentions — called right after GLiNER extraction, before LLM.
 * Links mentions to canonical entities when a match exists.
 */
export async function storeGLiNERMentions(
  db: DB,
  input: MentionInput,
  mentions: GLiNERMention[],
): Promise<void> {
  if (mentions.length === 0) return

  const rows = await Promise.all(
    mentions.map(async (m) => {
      const entityId = await findEntityId(db, input.palaceId, m.rawText, m.type)
      return {
        locigramId: input.locigramId,
        entityId,
        rawText:    m.rawText,
        type:       m.type,
        confidence: m.confidence,
        source:     'gliner' as const,
        spanStart:  m.spanStart,
        spanEnd:    m.spanEnd,
        palaceId:   input.palaceId,
      }
    }),
  )

  await db.insert(entityMentions).values(rows)
}

/**
 * Store LLM-extracted entity mentions — called after LLM extraction + entity resolution.
 * LLM mentions don't have span offsets or precise confidence, so we use a fixed 0.7.
 */
export async function storeLLMMentions(
  db: DB,
  input: MentionInput,
  extracted: ExtractionResult['entities'],
): Promise<void> {
  if (extracted.length === 0) return

  const rows = await Promise.all(
    extracted.map(async (e) => {
      const entityId = await findEntityId(db, input.palaceId, e.name, e.type)
      return {
        locigramId: input.locigramId,
        entityId,
        rawText:    e.name,
        type:       e.type,
        confidence: 0.7,
        source:     'llm' as const,
        spanStart:  null,
        spanEnd:    null,
        palaceId:   input.palaceId,
      }
    }),
  )

  await db.insert(entityMentions).values(rows)
}

/**
 * Find canonical entity by name or alias match.
 * Returns entity ID or null if no match.
 */
async function findEntityId(
  db: DB,
  palaceId: string,
  name: string,
  _type: string,
): Promise<string | null> {
  const [match] = await db
    .select({ id: entitiesTable.id })
    .from(entitiesTable)
    .where(
      and(
        eq(entitiesTable.palaceId, palaceId),
        sql`(${entitiesTable.name} = ${name} OR ${entitiesTable.aliases} @> ARRAY[${name}]::text[])`,
      ),
    )
    .limit(1)

  return match?.id ?? null
}
