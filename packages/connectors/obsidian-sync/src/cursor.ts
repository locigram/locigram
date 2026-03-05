import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

export interface CursorEntry {
  mtime: string
  locigramSourceRef: string
}

export interface SyncCursor {
  version: number
  synced: Record<string, CursorEntry>
}

const DEFAULT_CURSOR_PATH = join(homedir(), '.locigram', 'obsidian-sync-cursor.json')

function getCursorPath(): string {
  return process.env.CURSOR_PATH ?? DEFAULT_CURSOR_PATH
}

export function loadCursor(): SyncCursor {
  const path = getCursorPath()
  if (!existsSync(path)) return { version: 1, synced: {} }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SyncCursor
  } catch {
    return { version: 1, synced: {} }
  }
}

export function saveCursor(cursor: SyncCursor): void {
  const path = getCursorPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cursor, null, 2), 'utf8')
}
