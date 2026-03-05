import { readFileSync, statSync } from 'fs'
import { join } from 'path'

const MAX_CONTENT = 3000
const FALLBACK_PREVIEW = 300

export function readNote(vaultPath: string, relPath: string): { content: string; mtime: string } {
  const fullPath = join(vaultPath, relPath)
  const stat = statSync(fullPath)
  const raw = readFileSync(fullPath, 'utf8')
  return {
    content: raw.slice(0, MAX_CONTENT),
    mtime: stat.mtime.toISOString(),
  }
}

export function notePreview(content: string): string {
  return content.slice(0, FALLBACK_PREVIEW)
}
