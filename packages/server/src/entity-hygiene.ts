/**
 * Entity Hygiene — Phase 9.6
 * Periodic maintenance for the entity system.
 *
 * Tasks:
 * 1. Orphan detection — entities with 0 mentions AND 0 locigrams references
 * 2. Type disagreement — entities where GLiNER and LLM disagree on type
 * 3. Type enforcement — run majority vote to fix stale canonical types
 * 4. Stats logging
 */

import { entities, entityMentions, locigrams } from '@locigram/db'
import { eq, and, sql, count, avg, inArray, notInArray } from 'drizzle-orm'
import type { DB } from '@locigram/db'

export async function runEntityHygiene(db: DB, palaceId: string): Promise<void> {
  console.log(`[entity-hygiene] starting for palace=${palaceId}`)
  const start = Date.now()

  // ── 1. Orphan detection ────────────────────────────────────────────────────
  // Find entities not referenced by any entity_mentions OR locigrams.entities
  const allEntities = await db
    .select({ id: entities.id, name: entities.name, type: entities.type })
    .from(entities)
    .where(eq(entities.palaceId, palaceId))

  let orphanCount = 0
  for (const entity of allEntities) {
    // Check entity_mentions
    const [mentionCheck] = await db
      .select({ cnt: count() })
      .from(entityMentions)
      .where(eq(entityMentions.entityId, entity.id))

    if (Number(mentionCheck.cnt) > 0) continue

    // Check locigrams.entities array
    const [locigramCheck] = await db
      .select({ cnt: count() })
      .from(locigrams)
      .where(and(
        eq(locigrams.palaceId, palaceId),
        sql`${locigrams.entities} @> ARRAY[${entity.name}]::text[]`,
      ))

    if (Number(locigramCheck.cnt) > 0) continue

    orphanCount++
    console.log(`[entity-hygiene] orphan: "${entity.name}" (${entity.type}) — 0 mentions, 0 locigram refs`)
  }

  // ── 2. Type disagreement ──────────────────────────────────────────────────
  // Find entities where GLiNER and LLM mention different types
  const disagreements = await db
    .select({
      entityId:   entityMentions.entityId,
      source:     entityMentions.source,
      type:       entityMentions.type,
      cnt:        count(),
      avgConf:    avg(entityMentions.confidence),
    })
    .from(entityMentions)
    .where(and(
      eq(entityMentions.palaceId, palaceId),
      sql`${entityMentions.entityId} IS NOT NULL`,
    ))
    .groupBy(entityMentions.entityId, entityMentions.source, entityMentions.type)

  // Group by entityId, check for type mismatches
  const byEntity = new Map<string, Array<{ source: string; type: string; cnt: number; avgConf: number }>>()
  for (const row of disagreements) {
    if (!row.entityId) continue
    const list = byEntity.get(row.entityId) ?? []
    list.push({ source: row.source, type: row.type, cnt: Number(row.cnt), avgConf: Number(row.avgConf ?? 0) })
    byEntity.set(row.entityId, list)
  }

  let disagreementCount = 0
  let typeFixCount = 0
  for (const [entityId, mentions] of byEntity) {
    const types = new Set(mentions.map(m => m.type))
    if (types.size <= 1) continue

    // Find the entity name for logging
    const [entity] = await db
      .select({ name: entities.name, type: entities.type })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1)

    if (!entity) continue

    // Find winning type by score = count × avgConfidence
    let bestType = entity.type
    let bestScore = 0
    for (const m of mentions) {
      const score = m.cnt * m.avgConf
      if (score > bestScore) {
        bestScore = score
        bestType = m.type
      }
    }

    if (bestType !== entity.type) {
      console.log(`[entity-hygiene] type fix: "${entity.name}" ${entity.type} → ${bestType} (score: ${bestScore.toFixed(2)})`)
      await db.update(entities)
        .set({ type: bestType, updatedAt: new Date() })
        .where(eq(entities.id, entityId))
      typeFixCount++
    } else {
      const breakdown = mentions.map(m => `${m.source}:${m.type}×${m.cnt}`).join(', ')
      console.log(`[entity-hygiene] type disagreement: "${entity.name}" — ${breakdown} (canonical: ${entity.type})`)
    }
    disagreementCount++
  }

  // ── 3. Stats ──────────────────────────────────────────────────────────────
  const [entityStats] = await db
    .select({ total: count() })
    .from(entities)
    .where(eq(entities.palaceId, palaceId))

  const [mentionStats] = await db
    .select({ total: count() })
    .from(entityMentions)
    .where(eq(entityMentions.palaceId, palaceId))

  const typeBreakdown = await db
    .select({ type: entities.type, cnt: count() })
    .from(entities)
    .where(eq(entities.palaceId, palaceId))
    .groupBy(entities.type)

  const typeStr = typeBreakdown.map(t => `${t.type}=${t.cnt}`).join(' ')

  console.log(`[entity-hygiene] done in ${Date.now() - start}ms — entities=${entityStats.total} mentions=${mentionStats.total} orphans=${orphanCount} disagreements=${disagreementCount} type_fixes=${typeFixCount} types: ${typeStr}`)
}
