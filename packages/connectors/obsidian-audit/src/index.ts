import { scanVault } from './vault'
import { evaluateBatch } from './llm'
import { getLocigrmaCoverage } from './locigram'
import { loadIndex, saveIndex, buildEntryMap, type IndexEntry } from './index-store'

const VAULT = process.env.OBSIDIAN_VAULT ?? '/Users/surubot/sudobrain'
const BATCH_SIZE = 10

async function main() {
  console.log(`[obsidian-audit] Starting — vault: ${VAULT}`)

  // Load existing index
  const index = loadIndex()
  const entryMap = buildEntryMap(index)
  console.log(`[obsidian-audit] Existing index: ${index.entries.length} entries`)

  // Scan vault
  const notes = scanVault(VAULT)

  // Find new or changed notes (mtime newer than lastAudited)
  const toEvaluate = notes.filter(note => {
    const existing = entryMap.get(note.path)
    if (!existing) return true // new note
    return note.mtime > existing.lastAudited // changed since last audit
  })

  console.log(`[obsidian-audit] Notes to evaluate: ${toEvaluate.length}`)

  if (toEvaluate.length === 0) {
    console.log('[obsidian-audit] Nothing new — index is current')
    saveIndex(index)
    return
  }

  // Get Locigram coverage context (once)
  const coverage = await getLocigrmaCoverage()
  console.log(`[obsidian-audit] Locigram coverage context: ${coverage.length} chars`)

  // Evaluate in batches
  let evaluated = 0
  for (let i = 0; i < toEvaluate.length; i += BATCH_SIZE) {
    const batch = toEvaluate.slice(i, i + BATCH_SIZE)
    console.log(`[obsidian-audit] Evaluating batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEvaluate.length / BATCH_SIZE)}`)

    const results = await evaluateBatch(
      batch.map(n => ({ path: n.path, preview: n.preview })),
      coverage,
    )

    const now = new Date().toISOString()
    for (const result of results) {
      const note = batch.find(n => n.path === result.path)
      if (!note) continue

      const entry: IndexEntry = {
        path: result.path,
        verdict: result.verdict,
        reason: result.reason,
        locus: result.locus,
        lastAudited: now,
        mtime: note.mtime,
      }

      entryMap.set(entry.path, entry)
      console.log(`  [${result.verdict.toUpperCase()}] ${result.path} — ${result.reason}`)
      evaluated++
    }

    // Small delay between batches to avoid overwhelming LLM
    if (i + BATCH_SIZE < toEvaluate.length) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  // Also mark notes that no longer exist as skip
  for (const [path, entry] of entryMap) {
    if (!notes.find(n => n.path === path) && entry.verdict === 'index') {
      entryMap.set(path, { ...entry, verdict: 'skip', reason: 'Note no longer exists in vault' })
    }
  }

  // Rebuild entries array
  index.entries = Array.from(entryMap.values())

  const indexCount = index.entries.filter(e => e.verdict === 'index').length
  const skipCount = index.entries.filter(e => e.verdict === 'skip').length
  const coveredCount = index.entries.filter(e => e.verdict === 'covered').length

  saveIndex(index)
  console.log(`[obsidian-audit] Done. Evaluated ${evaluated} notes.`)
  console.log(`  Index: ${indexCount} | Skip: ${skipCount} | Covered: ${coveredCount}`)
}

main().catch(err => {
  console.error('[obsidian-audit] Fatal error:', err)
  process.exit(1)
})
