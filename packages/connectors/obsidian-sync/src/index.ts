import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readNote } from './vault'
import { summarizeNote } from './llm'
import { upsertMemory } from './locigram'
import { loadCursor, saveCursor } from './cursor'

const VAULT = process.env.OBSIDIAN_VAULT ?? '/Users/surubot/sudobrain'
const INDEX_PATH = process.env.INDEX_PATH ?? join(homedir(), '.locigram', 'obsidian-index.json')

interface IndexEntry {
  path: string
  verdict: 'index' | 'skip' | 'covered'
  locus: string
  mtime: string
}

interface IndexFile {
  entries: IndexEntry[]
}

function buildDeepLink(relPath: string): string {
  const pathWithoutExt = relPath.replace(/\.md$/, '')
  const encoded = encodeURIComponent(pathWithoutExt).replace(/%2F/g, '/')
  return `obsidian://open?vault=sudobrain&file=${encoded}`
}

async function main() {
  console.log('[obsidian-sync] Starting')

  if (!existsSync(INDEX_PATH)) {
    console.log(`[obsidian-sync] No index file found at ${INDEX_PATH} — run obsidian-audit first`)
    process.exit(0)
  }

  const indexFile = JSON.parse(await Bun.file(INDEX_PATH).text()) as IndexFile
  const approved = indexFile.entries.filter(e => e.verdict === 'index')
  console.log(`[obsidian-sync] Approved notes to sync: ${approved.length}`)

  const cursor = loadCursor()
  let synced = 0
  let skipped = 0
  let failed = 0

  for (const entry of approved) {
    try {
      const { content, mtime } = readNote(VAULT, entry.path)
      const existing = cursor.synced[entry.path]

      // Skip if not changed since last sync
      if (existing && mtime <= existing.mtime) {
        skipped++
        continue
      }

      // Summarize
      const summary = await summarizeNote(content, entry.path)
      const deepLink = buildDeepLink(entry.path)
      const memoryContent = `${summary}\n\nSource: ${entry.path}\nObsidian: ${deepLink}`
      const sourceRef = `obsidian:${entry.path}`

      // Upsert to Locigram
      await upsertMemory(memoryContent, entry.locus, sourceRef)

      // Update cursor
      cursor.synced[entry.path] = { mtime, locigramSourceRef: sourceRef }
      synced++

      console.log(`  [SYNCED] ${entry.path}`)

      // Small delay to avoid hammering LLM
      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      console.error(`  [FAILED] ${entry.path}: ${err}`)
      failed++
    }
  }

  saveCursor(cursor)
  console.log(`[obsidian-sync] Done. Synced: ${synced} | Skipped (unchanged): ${skipped} | Failed: ${failed}`)
}

main().catch(err => {
  console.error('[obsidian-sync] Fatal error:', err)
  process.exit(1)
})
