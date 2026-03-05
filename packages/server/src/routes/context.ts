import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { locigrams } from '@locigram/db'
import { runQueryWithResult } from '../graph/graph-client'

// ── GET /api/context/active ─────────────────────────────────────────────────
// Returns the latest locigram for a given locus (typically agent/{name}/context).
// Legacy flat loci like agent/{name} are mapped to agent/{name}/context.

export const activeContextRoute = new Hono()

activeContextRoute.get('/', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  let locus = c.req.query('locus') ?? ''

  if (!locus) {
    return c.json({ error: 'locus query parameter is required' }, 400)
  }

  // Legacy mapping: agent/{name} → agent/{name}/context
  const parts = locus.split('/')
  if (parts.length === 2 && parts[0] === 'agent') {
    locus = `${locus}/context`
  }

  const rows = await db
    .select()
    .from(locigrams)
    .where(
      sql`${locigrams.palaceId} = ${palace.id}
        AND ${locigrams.locus} = ${locus}
        AND ${locigrams.expiresAt} IS NULL`
    )
    .orderBy(sql`${locigrams.createdAt} DESC`)
    .limit(1)

  if (rows.length === 0) {
    return c.json(null)
  }

  const row = rows[0]

  // Try to parse structured data from content
  let structured: Record<string, unknown> | null = null
  try {
    structured = JSON.parse(row.content)
  } catch {
    // Content is narrative, not structured JSON
  }

  // If structured, return it directly; otherwise wrap content
  if (structured && typeof structured === 'object' && structured.currentTask) {
    return c.json(structured)
  }

  return c.json({
    content: row.content,
    locus: row.locus,
    createdAt: row.createdAt,
    metadata: row.metadata,
  })
})

// ── GET /api/context/fleet ──────────────────────────────────────────────────
// Returns an array of all agents that have pushed context, with their latest state.

export const fleetRoute = new Hono()

fleetRoute.get('/', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')

  // Fetch all context locigrams matching agent/*/context, then deduplicate in JS
  const allRows = await db
    .select()
    .from(locigrams)
    .where(
      sql`${locigrams.palaceId} = ${palace.id}
        AND ${locigrams.locus} LIKE 'agent/%/context'
        AND ${locigrams.expiresAt} IS NULL`
    )
    .orderBy(sql`${locigrams.createdAt} DESC`)

  // Deduplicate: keep only the latest row per agent name
  const seen = new Set<string>()
  const deduped = allRows.filter(row => {
    const agentName = row.locus.split('/')[1] ?? 'unknown'
    if (seen.has(agentName)) return false
    seen.add(agentName)
    return true
  })

  const agents = deduped.map((row) => {
    const agentName = row.locus.split('/')[1] ?? 'unknown'

    // Try to parse structured context from content
    let structured: Record<string, unknown> = {}
    try {
      structured = JSON.parse(row.content)
    } catch {
      // Not structured JSON
    }

    return {
      agentName,
      currentTask: structured.currentTask ?? null,
      currentProject: structured.currentProject ?? null,
      blockers: structured.blockers ?? [],
      domain: structured.domain ?? null,
      lastSeen: row.createdAt,
      agentType: (row.metadata as any)?.agentType ?? 'permanent',
    }
  })

  // Augment with Memgraph: get agents with recent memories from graph
  // Merges in any agents present in graph but missing from Postgres context locus
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const graphAgents = await runQueryWithResult<{ agentName: string; lastSeen: string }>(
      `MATCH (m:Memory)-[:OWNED_BY]->(a:Agent)
       WHERE m.occurredAt > $cutoff
       WITH a, m ORDER BY m.occurredAt DESC
       WITH a, COLLECT(m)[0] AS latest
       RETURN a.name AS agentName, latest.occurredAt AS lastSeen`,
      { cutoff }
    )
    const seenInPostgres = new Set(agents.map(a => a.agentName))
    for (const ga of graphAgents) {
      if (!seenInPostgres.has(ga.agentName)) {
        agents.push({
          agentName: ga.agentName,
          currentTask: null,
          currentProject: null,
          blockers: [],
          domain: null,
          lastSeen: new Date(ga.lastSeen),
          agentType: 'permanent',
        })
      }
    }
  } catch (e) {
    console.warn('[graph] fleet augment failed:', e)
  }

  return c.json(agents)
})

// ── POST /api/agents/:agentName/heartbeat ───────────────────────────────────
// Stores a lightweight heartbeat locigram under locus agent/{agentName}/heartbeat.

export const heartbeatRoute = new Hono()

heartbeatRoute.post('/:agentName/heartbeat', async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const agentName = c.req.param('agentName')

  let body: { agentType?: string; status?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    // Empty body is fine
  }

  const agentType = body.agentType ?? 'permanent'
  const status = body.status ?? 'alive'
  const now = new Date()
  const locus = `agent/${agentName}/heartbeat`
  const sourceRef = `heartbeat:${agentName}:${now.toISOString()}`

  await db.insert(locigrams).values({
    content: JSON.stringify({ agentType, status, agentName, timestamp: now.toISOString() }),
    sourceType: 'system',
    sourceRef,
    locus,
    occurredAt: now,
    entities: [agentName],
    metadata: { agentType, status, connector: 'session-monitor-heartbeat' },
    palaceId: palace.id,
    isReference: false,
    importance: 'low',
  })

  return c.json({ ok: true, lastSeen: now.toISOString() })
})
