import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

export interface IndexEntry {
  path: string
  verdict: 'index' | 'skip' | 'covered'
  reason: string
  locus: string
  lastAudited: string
  mtime: string
}

export interface IndexFile {
  generated: string
  version: number
  entries: IndexEntry[]
}

const DEFAULT_INDEX_PATH = join(homedir(), '.locigram', 'obsidian-index.json')

export function getIndexPath(): string {
  return process.env.INDEX_PATH ?? DEFAULT_INDEX_PATH
}

export function loadIndex(): IndexFile {
  const path = getIndexPath()
  if (!existsSync(path)) {
    return { generated: new Date().toISOString(), version: 1, entries: [] }
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as IndexFile
  } catch {
    console.warn('[obsidian-audit] Could not parse index file, starting fresh')
    return { generated: new Date().toISOString(), version: 1, entries: [] }
  }
}

export function saveIndex(index: IndexFile): void {
  const path = getIndexPath()
  mkdirSync(dirname(path), { recursive: true })
  index.generated = new Date().toISOString()
  writeFileSync(path, JSON.stringify(index, null, 2), 'utf8')
  console.log(`[obsidian-audit] Index saved: ${index.entries.length} entries → ${path}`)
}

export function buildEntryMap(index: IndexFile): Map<string, IndexEntry> {
  return new Map(index.entries.map(e => [e.path, e]))
}
