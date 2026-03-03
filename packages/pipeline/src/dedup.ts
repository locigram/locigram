import { locigrams } from '@locigram/db'
import { eq, and } from 'drizzle-orm'
import type { DB } from '@locigram/db'

export async function isDuplicate(
  db: DB,
  palaceId: string,
  sourceRef: string | undefined,
): Promise<boolean> {
  if (!sourceRef) return false

  const [existing] = await db
    .select({ id: locigrams.id })
    .from(locigrams)
    .where(and(eq(locigrams.palaceId, palaceId), eq(locigrams.sourceRef, sourceRef)))
    .limit(1)

  return !!existing
}
