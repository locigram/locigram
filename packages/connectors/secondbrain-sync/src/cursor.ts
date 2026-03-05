import type postgres from 'postgres'

const CURSOR_KEY = 'secondbrain_sync_cursor'

export interface SyncCursor {
  lastRun: string
  version: number
}

export async function ensureKvTable(sql: postgres.Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS public.kv (key TEXT PRIMARY KEY, value TEXT)`
}

export async function readCursor(sql: postgres.Sql): Promise<SyncCursor | null> {
  const rows = await sql`SELECT value FROM public.kv WHERE key = ${CURSOR_KEY}`
  if (rows.length === 0) return null
  return JSON.parse(rows[0].value) as SyncCursor
}

export async function writeCursor(sql: postgres.Sql): Promise<void> {
  const cursor: SyncCursor = {
    lastRun: new Date().toISOString(),
    version: 1,
  }
  const value = JSON.stringify(cursor)
  await sql`
    INSERT INTO public.kv (key, value) VALUES (${CURSOR_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = ${value}
  `
}
