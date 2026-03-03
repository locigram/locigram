import { entities as entitiesTable } from '@locigram/db'
import { eq, and, sql } from 'drizzle-orm'
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
