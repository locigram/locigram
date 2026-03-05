import { readdirSync, statSync, readFileSync } from 'fs'
import { join, relative } from 'path'

export interface VaultNote {
  path: string       // relative to vault root e.g. "Infrastructure/MCP-Servers.md"
  fullPath: string   // absolute
  mtime: string      // ISO timestamp
  size: number
  preview: string    // first 500 chars
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const JUNK_STUB = '# Current State\n- Newly detected'

function shouldSkip(relPath: string, content: string, size: number): boolean {
  const filename = relPath.split('/').pop() ?? ''
  // Skip long filenames (agent build artifacts)
  if (filename.replace('.md', '').length > 60) return true
  // Skip UUID in filename
  if (UUID_PATTERN.test(filename)) return true
  // Skip empty/stub files
  if (size < 100) return true
  // Skip archived paths
  if (relPath.includes('archive/') || relPath.includes('retired/')) return true
  // Skip session-monitor stubs
  if (content.startsWith(JUNK_STUB)) return true
  // Skip People/ entirely — auto-generated email contacts, covered by intel.people in SuruDB
  if (relPath.startsWith('People/')) return true
  // Skip Business/Client-Users/ — auto-generated team contact lists
  if (relPath.startsWith('Business/Client-Users/')) return true
  return false
}

function scanDir(dir: string, vault: string, results: VaultNote[]): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue
      scanDir(fullPath, vault, results)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const relPath = relative(vault, fullPath)
      const stat = statSync(fullPath)
      const size = stat.size
      let content = ''
      try { content = readFileSync(fullPath, 'utf8') } catch { continue }
      if (shouldSkip(relPath, content, size)) continue
      results.push({
        path: relPath,
        fullPath,
        mtime: stat.mtime.toISOString(),
        size,
        preview: content.slice(0, 500),
      })
    }
  }
}

export function scanVault(vaultPath: string): VaultNote[] {
  const results: VaultNote[] = []
  scanDir(vaultPath, vaultPath, results)
  console.log(`[obsidian-audit] Scanned vault: ${results.length} eligible notes`)
  return results
}
