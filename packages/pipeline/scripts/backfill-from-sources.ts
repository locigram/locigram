#!/usr/bin/env bun
/**
 * Phase 6 — Backfill structured facts from high-value source documents:
 * - Decisions/Architecture Log.md
 * - memory/YYYY-MM-DD.md files (decisions/conventions/rules sections)
 *
 * Pushes directly via Locigram /api/remember endpoint with structured fields.
 * No LLM extraction needed — we parse known patterns from the docs.
 *
 * Usage: bun run scripts/backfill-from-sources.ts [--dry-run]
 */

const DRY_RUN = process.argv.includes('--dry-run')
const LOCIGRAM_URL = process.env.LOCIGRAM_URL ?? 'http://10.10.100.82:30310'
const LOCIGRAM_TOKEN = process.env.LOCIGRAM_TOKEN
if (!LOCIGRAM_TOKEN && !DRY_RUN) {
  console.error('Set LOCIGRAM_TOKEN')
  process.exit(1)
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface StructuredFact {
  content: string
  subject: string
  predicate: string
  object_val: string
  category: 'decision' | 'convention' | 'fact' | 'preference' | 'lesson'
  durability_class: 'permanent' | 'stable' | 'active'
  locus: string
  source_ref: string
  importance: 'high' | 'normal'
}

// ── Parser helpers ─────────────────────────────────────────────────────────────

function extractArchitectureDecisions(content: string, filePath: string): StructuredFact[] {
  const facts: StructuredFact[] = []
  // Match ## YYYY-MM-DD: Title blocks
  const sectionRegex = /^## (\d{4}-\d{2}-\d{2}): (.+)\n([\s\S]+?)(?=^## |\Z)/gm
  let match
  while ((match = sectionRegex.exec(content)) !== null) {
    const [, date, title, body] = match
    const decisionLine = body.match(/\*\*Decision:\*\*\s*(.+)/)?.[1]?.trim()
    const whyLine = body.match(/\*\*Why:\*\*\s*(.+)/)?.[1]?.trim()

    if (!decisionLine) continue

    const fullContent = `[${date}] Decision: ${title}. ${decisionLine}${whyLine ? ' Reason: ' + whyLine : ''}`
    facts.push({
      content: fullContent,
      subject: title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 60),
      predicate: 'decided',
      object_val: decisionLine.slice(0, 200),
      category: 'decision',
      durability_class: 'permanent',
      locus: 'decisions/architecture',
      source_ref: `obsidian:Decisions/Architecture Log.md:${title.slice(0, 40)}`,
      importance: 'high',
    })
  }
  return facts
}

function extractMemoryFileConventions(content: string, filename: string): StructuredFact[] {
  const facts: StructuredFact[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Convention patterns: bullets OR headings with NEVER, Always, rule:, policy:
    if (/^(?:[-*#]+\s+)?(NEVER|Never|Always|Rule:|Policy:|Convention:)\s+.{20,}/.test(line)) {
      const text = line.replace(/^[-*#]+\s+/, '')
      facts.push({
        content: text,
        subject: filename,
        predicate: text.startsWith('NEVER') || text.startsWith('Never') ? 'prohibited' : 'required',
        object_val: text.slice(0, 200),
        category: 'convention',
        durability_class: 'permanent',
        locus: 'agent/main/conventions',
        source_ref: `memory:${filename}:${i + 1}`,
        importance: 'high',
      })
    }

    // Decision patterns: "Decided:", "Decision:", "✅ Decision:"
    if (/^[-*#]?\s*(?:\*\*)?(?:Decided?|Decision|Resolved|Agreed)[:\s*]/.test(line) && line.length > 30) {
      const text = line.replace(/^[-*#]?\s*(?:\*\*)?(?:Decided?|Decision|Resolved|Agreed)[:\s*]*(?:\*\*)?/, '').trim()
      if (text.length < 20) continue
      facts.push({
        content: `${line.trim()}`,
        subject: 'architecture',
        predicate: 'decided',
        object_val: text.slice(0, 200),
        category: 'decision',
        durability_class: 'permanent',
        locus: 'decisions/architecture',
        source_ref: `memory:${filename}:${i + 1}`,
        importance: 'high',
      })
    }
  }
  return facts
}

// ── Push to Locigram ──────────────────────────────────────────────────────────

async function pushFact(fact: StructuredFact): Promise<boolean> {
  const body = {
    content: fact.content,
    locus: fact.locus,
    sourceType: 'system',
    sourceRef: fact.source_ref,
    subject: fact.subject,
    predicate: fact.predicate,
    object_val: fact.object_val,
    category: fact.category,
    durability_class: fact.durability_class,
    importance: fact.importance,
    entities: [],
  }

  const res = await fetch(`${LOCIGRAM_URL}/api/remember`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LOCIGRAM_TOKEN}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    // Treat duplicate source_ref as success (already exists)
    if (res.status === 500 && err.includes('duplicate key')) return true
    console.warn(`[backfill] push failed (${res.status}): ${err.slice(0, 100)}`)
    return false
  }
  return true
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backfill] Phase 6 — structured facts from source docs (dry_run=${DRY_RUN})`)

  const allFacts: StructuredFact[] = []

  // 1. Architecture decisions log
  const archLogPath = '/home/sudobot/vault/sudobrain/Decisions/Architecture Log.md'
  try {
    const content = await Bun.file(archLogPath).text()
    const facts = extractArchitectureDecisions(content, archLogPath)
    console.log(`[backfill] Architecture Log: ${facts.length} decisions found`)
    allFacts.push(...facts)
  } catch (e: any) {
    console.warn(`[backfill] Could not read Architecture Log: ${e.message}`)
  }

  // 2. Recent memory files (last 7 days)
  const memDir = '/home/sudobot/.openclaw/workspace/memory'
  const { readdirSync } = await import('node:fs')
  const memFiles: string[] = readdirSync(memDir)
    .filter((f: string) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))

  for (const fname of memFiles.sort().slice(-7)) {
    try {
      const content = await Bun.file(`${memDir}/${fname}`).text()
      const facts = extractMemoryFileConventions(content, fname)
      if (facts.length > 0) console.log(`[backfill] ${fname}: ${facts.length} conventions/decisions found`)
      allFacts.push(...facts)
    } catch (e: any) {
      console.warn(`[backfill] Could not read ${fname}: ${e.message}`)
    }
  }

  // 3. Obsidian project docs — decisions log tables and decision sections
  const obsidianDirs = [
    '/home/sudobot/vault/sudobrain/Projects',
    '/home/sudobot/vault/sudobrain/Infrastructure',
    '/home/sudobot/vault/sudobrain/Decisions',
  ]

  for (const dir of obsidianDirs) {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f: string) => f.endsWith('.md') && !f.startsWith('_'))
    } catch { continue }

    for (const fname of files) {
      try {
        const content = await Bun.file(`${dir}/${fname}`).text()
        const relPath = `${dir.split('sudobrain/')[1]}/${fname}`

        // Skip the Architecture Log — already handled above
        if (relPath === 'Decisions/Architecture Log.md') continue

        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()

          // Decisions log table rows: | date | decision | rationale |
          if (/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) {
            const cells = line.split('|').map(c => c.trim()).filter(Boolean)
            if (cells.length >= 2) {
              const [date, decision, rationale] = cells
              if (decision && decision.length > 15 && !decision.startsWith('---') && !decision.toLowerCase().startsWith('decision')) {
                allFacts.push({
                  content: `[${date}] ${decision}${rationale ? ' — ' + rationale : ''}`,
                  subject: relPath.replace(/\.md$/, '').replace(/\//g, '_').toLowerCase().slice(0, 60),
                  predicate: 'decided',
                  object_val: decision.slice(0, 200),
                  category: 'decision',
                  durability_class: 'permanent',
                  locus: `decisions/${relPath.split('/')[0].toLowerCase()}`,
                  source_ref: `obsidian:${relPath}:${i + 1}`,
                  importance: 'high',
                })
              }
            }
          }

          // Decision headings or bold decision lines
          if (/^(?:#{1,4}\s+)?(?:\*\*)?Decision[:\s]/i.test(line) && line.length > 30) {
            const text = line.replace(/^(?:#{1,4}\s+)?(?:\*\*)?Decision[:\s]*(?:\*\*)?/i, '').trim()
            if (text.length < 15) continue
            // Grab the next line for context if it starts with Why/Reason
            let reason = ''
            if (i + 1 < lines.length && /^\*\*(?:Why|Reason)[:\s]/i.test(lines[i + 1].trim())) {
              reason = lines[i + 1].trim().replace(/^\*\*(?:Why|Reason)[:\s]*\*\*\s*/i, '')
            }
            allFacts.push({
              content: `Decision: ${text}${reason ? ' Reason: ' + reason : ''}`,
              subject: relPath.replace(/\.md$/, '').replace(/\//g, '_').toLowerCase().slice(0, 60),
              predicate: 'decided',
              object_val: text.slice(0, 200),
              category: 'decision',
              durability_class: 'permanent',
              locus: `decisions/${relPath.split('/')[0].toLowerCase()}`,
              source_ref: `obsidian:${relPath}:${i + 1}`,
              importance: 'high',
            })
          }

          // Architecture facts: "runs on", "deployed at", "serves", "hosts"
          if (/^\|\s*\S+\s*\|\s*`?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`?\s*\|/.test(line)) {
            const cells = line.split('|').map(c => c.trim()).filter(Boolean)
            if (cells.length >= 3) {
              const [host, ip, role] = cells
              allFacts.push({
                content: `${host} (${ip}) — ${role}`,
                subject: host.replace(/`/g, '').trim().toLowerCase(),
                predicate: 'has_role',
                object_val: `${ip} — ${role}`.slice(0, 200),
                category: 'fact',
                durability_class: 'stable',
                locus: `infrastructure/${relPath.split('/')[0].toLowerCase()}`,
                source_ref: `obsidian:${relPath}:${i + 1}`,
                importance: 'normal',
              })
            }
          }
        }
      } catch (e: any) {
        // Skip unreadable files
      }
    }
  }

  // Deduplicate by source_ref
  const seen = new Set<string>()
  const deduped = allFacts.filter(f => {
    if (seen.has(f.source_ref)) return false
    seen.add(f.source_ref)
    return true
  })

  console.log(`[backfill] Total: ${deduped.length} unique facts to push`)

  if (DRY_RUN) {
    for (const f of deduped.slice(0, 10)) {
      console.log(`  [dry] ${f.category}/${f.durability_class} — ${f.content.slice(0, 80)}`)
    }
    if (deduped.length > 10) console.log(`  ... and ${deduped.length - 10} more`)
    return
  }

  let pushed = 0, failed = 0
  for (const fact of deduped) {
    const ok = await pushFact(fact)
    if (ok) pushed++; else failed++
    if ((pushed + failed) % 20 === 0) console.log(`[backfill] progress: ${pushed} pushed, ${failed} failed`)
    // Tiny delay to avoid hammering the API
    await new Promise(r => setTimeout(r, 100))
  }

  console.log(`[backfill] DONE: ${pushed} pushed, ${failed} failed`)
}

main().catch(e => { console.error('[backfill] fatal:', e); process.exit(1) })
