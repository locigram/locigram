import { entities as entitiesTable, entityMentions } from '@locigram/db'
import { eq, and, sql, count, avg } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import type { ExtractionResult } from './extract'

type ExtractedEntity = ExtractionResult['entities'][number]

export async function resolveEntities(
  db: DB,
  palaceId: string,
  extracted: ExtractedEntity[],
): Promise<string[]> {
  const resolvedNames: string[] = []

  for (const entity of extracted) {
    // Try match by canonical name or aliases
    const [existing] = await db
      .select()
      .from(entitiesTable)
      .where(
        and(
          eq(entitiesTable.palaceId, palaceId),
          sql`(${entitiesTable.name} = ${entity.name} OR ${entitiesTable.aliases} @> ARRAY[${entity.name}]::text[])`,
        ),
      )
      .limit(1)

    if (existing) {
      // Add any new aliases we found
      const newAliases = entity.aliases.filter(a => !existing.aliases.includes(a))
      if (newAliases.length > 0) {
        await db
          .update(entitiesTable)
          .set({ aliases: [...existing.aliases, ...newAliases] })
          .where(eq(entitiesTable.id, existing.id))
      }
      resolvedNames.push(existing.name)
    } else {
      // Create new entity
      const [created] = await db
        .insert(entitiesTable)
        .values({
          name:     entity.name,
          type:     entity.type,
          aliases:  entity.aliases,
          metadata: {},
          palaceId,
        })
        .returning()
      resolvedNames.push(created.name)
    }
  }

  return resolvedNames
}

/**
 * Phase 9.3 — Entity type enforcement via majority vote across mentions.
 * For a given entity, count mentions by type weighted by avg confidence.
 * If the winning type differs from the current canonical type, update it.
 *
 * Returns true if the type was changed.
 */
export async function enforceEntityType(
  db: DB,
  entityId: string,
): Promise<boolean> {
  // Get current entity
  const [entity] = await db
    .select()
    .from(entitiesTable)
    .where(eq(entitiesTable.id, entityId))
    .limit(1)

  if (!entity) return false

  // Aggregate mentions by type: count × avg confidence = score
  const typeVotes = await db
    .select({
      type:       entityMentions.type,
      voteCount:  count(),
      avgConf:    avg(entityMentions.confidence),
    })
    .from(entityMentions)
    .where(eq(entityMentions.entityId, entityId))
    .groupBy(entityMentions.type)

  if (typeVotes.length === 0) return false

  // Find winning type by score = count × avgConfidence
  let bestType = entity.type
  let bestScore = 0
  for (const vote of typeVotes) {
    const score = Number(vote.voteCount) * Number(vote.avgConf ?? 0)
    if (score > bestScore) {
      bestScore = score
      bestType = vote.type
    }
  }

  if (bestType !== entity.type) {
    await db
      .update(entitiesTable)
      .set({ type: bestType, updatedAt: new Date() })
      .where(eq(entitiesTable.id, entityId))
    console.log(`[resolve] entity "${entity.name}" type changed: ${entity.type} → ${bestType} (score: ${bestScore.toFixed(2)})`)
    return true
  }

  return false
}
