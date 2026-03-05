import { runQuery } from './graph-client'

export interface MemoryGraphInput {
  id: string
  palaceId: string
  locus: string
  sourceType: string
  agentName?: string
  sessionId?: string
  importance?: string | null
  occurredAt: Date
  connector?: string | null
}

export function parseAgentFromLocus(locus: string): string | undefined {
  const parts = locus.split('/')
  if (parts[0] === 'agent' && parts[1]) return parts[1]
  return undefined
}

export async function writeMemoryToGraph(input: MemoryGraphInput): Promise<void> {
  const { id, palaceId, locus, sourceType, agentName, sessionId, importance, occurredAt, connector } = input

  // Memory + Palace
  await runQuery(`
    MERGE (p:Palace {id: $palaceId})
    MERGE (m:Memory {id: $id})
    SET m.locus = $locus,
        m.sourceType = $sourceType,
        m.importance = $importance,
        m.occurredAt = $occurredAt,
        m.connector = $connector
    MERGE (m)-[:IN_PALACE]->(p)
  `, {
    id, palaceId, locus, sourceType,
    importance: importance ?? 'normal',
    occurredAt: occurredAt.toISOString(),
    connector: connector ?? null,
  })

  // Locus node
  const locusTop = locus.split('/')[0]
  await runQuery(`
    MERGE (l:Locus {path: $locus})
    SET l.top = $locusTop
    MERGE (m:Memory {id: $id})
    MERGE (m)-[:HAS_LOCUS]->(l)
  `, { locus, locusTop, id })

  // Agent node
  if (agentName) {
    await runQuery(`
      MERGE (a:Agent {name: $agentName})
      MERGE (m:Memory {id: $id})
      MERGE (m)-[:OWNED_BY]->(a)
    `, { agentName, id })
  }

  // Session node
  if (sessionId) {
    await runQuery(`
      MERGE (s:Session {id: $sessionId})
      SET s.agentName = $agentName
      MERGE (m:Memory {id: $id})
      MERGE (m)-[:PART_OF]->(s)
    `, { sessionId, agentName: agentName ?? 'unknown', id })

    if (agentName) {
      await runQuery(`
        MERGE (a:Agent {name: $agentName})
        MERGE (s:Session {id: $sessionId})
        MERGE (s)-[:RUN_BY]->(a)
      `, { agentName, sessionId })
    }
  }
}
