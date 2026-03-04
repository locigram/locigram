import { eq, and } from 'drizzle-orm'
import { syncCursors } from './schema'
import type { DB } from './client'

export async function getCursor(db: DB, palaceId: string, source: string): Promise<string | null> {
  const rows = await db.select({ cursor: syncCursors.cursor })
    .from(syncCursors)
    .where(and(eq(syncCursors.palaceId, palaceId), eq(syncCursors.source, source)))
    .limit(1)
  return rows[0]?.cursor ?? null
}

export async function setCursor(db: DB, palaceId: string, source: string, cursor: string): Promise<void> {
  await db.insert(syncCursors)
    .values({ palaceId, source, cursor })
    .onConflictDoUpdate({
      target: [syncCursors.palaceId, syncCursors.source],
      set: { cursor, updatedAt: new Date() },
    })
}
