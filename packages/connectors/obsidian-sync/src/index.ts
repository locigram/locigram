import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readNote } from './vault'
import { summarizeNote } from './llm'
import { upsertMemory, reportSync } from './locigram'
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
  const startTime = Date.now()
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

      // Upsert to Locigram via connector ingest endpoint
      await upsertMemory(memoryContent, sourceRef)

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

  const durationMs = Date.now() - startTime

  // Report sync results to Locigram
  try {
    await reportSync({
      itemsPulled:  approved.length,
      itemsPushed:  synced,
      itemsSkipped: skipped,
      durationMs,
      ...(failed > 0 ? { error: `${failed} notes failed` } : {}),
    })
    console.log(`[obsidian-sync] Reported to Locigram`)
  } catch (err) {
    console.warn(`[obsidian-sync] Failed to report: ${err}`)
  }

  console.log(`[obsidian-sync] Done in ${(durationMs / 1000).toFixed(1)}s. Synced: ${synced} | Skipped (unchanged): ${skipped} | Failed: ${failed}`)
}

main().catch(err => {
  console.error('[obsidian-sync] Fatal error:', err)
  process.exit(1)
})
