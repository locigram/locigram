#!/usr/bin/env bun
/**
 * Phase 9.5 — Entity cleanup script
 * One-time fix for dirty entity data accumulated from LLM-only extraction.
 *
 * Usage: DATABASE_URL=... bun run packages/pipeline/scripts/entity-cleanup.ts [--dry-run]
 */

import postgres from 'postgres'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) { console.error('[cleanup] DATABASE_URL required'); process.exit(1) }

const dryRun = process.argv.includes('--dry-run')
const sql = postgres(DATABASE_URL)

// ── Merge rules ─────────────────────────────────────────────────────────────
// [keepId, ...mergeIds] — first ID is the survivor

interface MergeRule {
  keepName: string
  keepType: string
  keepAliases: string[]
  mergeNames: string[]  // names to merge INTO the keeper
}

const MERGES: MergeRule[] = [
  {
    // "AI Assistant", "Memory Extraction Assistant", "Agent Main" → single "AI Assistant" entity
    keepName: 'AI Assistant',
    keepType: 'product',  // it's software, not a person
    keepAliases: ['assistant', 'main', 'Session Summarizer', 'Agent', 'AI', 'Scribe agent', 'Extraction Assistant', 'System', 'agent', 'Agent Main'],
    mergeNames: ['Memory Extraction Assistant', 'Agent Main'],
  },
  {
    // "surubot" + "Surubot" → single "surubot" (it's a service account, not a person)
    keepName: 'surubot',
    keepType: 'product',
    keepAliases: ['Surubot', 'surubot user', 'bot'],
    mergeNames: ['Surubot'],
  },
  {
    // "main" (org) → merge into AI Assistant (it's an agent name, not an org)
    keepName: 'AI Assistant',
    keepType: 'product',
    keepAliases: [],  // already covered above
    mergeNames: ['main'],
  },
  {
    // "Scribe Agent" (org) → merge into AI Assistant
    keepName: 'AI Assistant',
    keepType: 'product',
    keepAliases: ['Scribe', 'scribe'],
    mergeNames: ['Scribe Agent'],
  },
]

// ── Alias fixes ─────────────────────────────────────────────────────────────
interface AliasFix {
  name: string
  removeAliases: string[]
  addAliases: string[]
}

const ALIAS_FIXES: AliasFix[] = [
  {
    // "surubot" had "surugpu" as alias — wrong, surugpu is a different server
    name: 'surubot',
    removeAliases: ['surugpu', 'user'],
    addAliases: [],
  },
]

// ── Type fixes ──────────────────────────────────────────────────────────────
interface TypeFix {
  name: string
  fromType: string
  toType: string
}

const TYPE_FIXES: TypeFix[] = [
  { name: 'User', fromType: 'person', toType: 'topic' },  // generic "User" is not a specific person
  { name: '10.0.1.50', fromType: 'org', toType: 'topic' },  // IP address, not an org
]

// ── Execute ─────────────────────────────────────────────────────────────────

const PALACE_ID = process.env.PALACE_ID ?? 'main'

async function run() {
  console.log(`[cleanup] palace=${PALACE_ID} dry_run=${dryRun}`)

  let mergeCount = 0
  let aliasFixCount = 0
  let typeFixCount = 0
  let deleteCount = 0

  // Process merges
  for (const merge of MERGES) {
    const [keeper] = await sql`
      SELECT id, name, type, aliases FROM entities
      WHERE palace_id = ${PALACE_ID} AND name = ${merge.keepName}
      LIMIT 1
    `
    if (!keeper) {
      console.log(`[cleanup] skip merge — keeper "${merge.keepName}" not found`)
      continue
    }

    for (const mergeName of merge.mergeNames) {
      const [victim] = await sql`
        SELECT id, name, aliases FROM entities
        WHERE palace_id = ${PALACE_ID} AND name = ${mergeName}
        LIMIT 1
      `
      if (!victim) {
        console.log(`[cleanup] skip merge — "${mergeName}" not found`)
        continue
      }

      console.log(`[cleanup] merge "${victim.name}" (${victim.id}) → "${keeper.name}" (${keeper.id})`)

      if (!dryRun) {
        // Repoint all locigrams.entities references
        await sql`
          UPDATE locigrams
          SET entities = array_replace(entities, ${victim.name}, ${keeper.name})
          WHERE palace_id = ${PALACE_ID} AND ${victim.name} = ANY(entities)
        `

        // Repoint entity_mentions
        await sql`
          UPDATE entity_mentions
          SET entity_id = ${keeper.id}
          WHERE entity_id = ${victim.id}
        `

        // Delete the victim
        await sql`DELETE FROM entities WHERE id = ${victim.id}`
        deleteCount++
      }
      mergeCount++
    }

    // Update keeper type + aliases
    const existingAliases: string[] = keeper.aliases ?? []
    const newAliases = [...new Set([...existingAliases, ...merge.keepAliases])]

    console.log(`[cleanup] update "${keeper.name}" type=${merge.keepType}, aliases=[${newAliases.join(', ')}]`)
    if (!dryRun) {
      await sql`
        UPDATE entities
        SET type = ${merge.keepType}, aliases = ${newAliases}, updated_at = NOW()
        WHERE id = ${keeper.id}
      `
    }
  }

  // Process alias fixes
  for (const fix of ALIAS_FIXES) {
    const [entity] = await sql`
      SELECT id, aliases FROM entities
      WHERE palace_id = ${PALACE_ID} AND name = ${fix.name}
      LIMIT 1
    `
    if (!entity) continue

    const currentAliases: string[] = entity.aliases ?? []
    const cleaned = currentAliases.filter(a => !fix.removeAliases.includes(a))
    const updated = [...new Set([...cleaned, ...fix.addAliases])]

    console.log(`[cleanup] alias fix "${fix.name}": remove=[${fix.removeAliases.join(',')}] add=[${fix.addAliases.join(',')}]`)
    if (!dryRun) {
      await sql`
        UPDATE entities SET aliases = ${updated}, updated_at = NOW()
        WHERE id = ${entity.id}
      `
    }
    aliasFixCount++
  }

  // Process type fixes
  for (const fix of TYPE_FIXES) {
    const [entity] = await sql`
      SELECT id, type FROM entities
      WHERE palace_id = ${PALACE_ID} AND name = ${fix.name} AND type = ${fix.fromType}
      LIMIT 1
    `
    if (!entity) continue

    console.log(`[cleanup] type fix "${fix.name}": ${fix.fromType} → ${fix.toType}`)
    if (!dryRun) {
      await sql`
        UPDATE entities SET type = ${fix.toType}, updated_at = NOW()
        WHERE id = ${entity.id}
      `
    }
    typeFixCount++
  }

  // Add "Andrew Le" alias to "Andrew"
  const [andrew] = await sql`
    SELECT id, aliases FROM entities
    WHERE palace_id = ${PALACE_ID} AND name = 'Andrew'
    LIMIT 1
  `
  if (andrew) {
    const aliases: string[] = andrew.aliases ?? []
    if (!aliases.includes('Andrew Le')) {
      console.log(`[cleanup] adding alias "Andrew Le" to "Andrew"`)
      if (!dryRun) {
        await sql`
          UPDATE entities SET aliases = ${[...aliases, 'Andrew Le', 'sudodrew']}, updated_at = NOW()
          WHERE id = ${andrew.id}
        `
      }
    }
  }

  console.log(`[cleanup] done — merges=${mergeCount} alias_fixes=${aliasFixCount} type_fixes=${typeFixCount} deleted=${deleteCount} dry_run=${dryRun}`)
  await sql.end()
}

run().catch(err => { console.error('[cleanup] fatal:', err); process.exit(1) })
