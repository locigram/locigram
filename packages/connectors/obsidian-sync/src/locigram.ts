// Locigram REST client — uses connector token + /ingest endpoint (Phase 3)
const LOCIGRAM_URL = process.env.LOCIGRAM_URL ?? 'http://10.10.100.82:30310'
const TOKEN = process.env.LOCIGRAM_CONNECTOR_TOKEN ?? ''
const INSTANCE_ID = process.env.LOCIGRAM_INSTANCE_ID ?? ''

if (!TOKEN) console.warn('[obsidian-sync] LOCIGRAM_CONNECTOR_TOKEN not set — ingests will fail')
if (!INSTANCE_ID) console.warn('[obsidian-sync] LOCIGRAM_INSTANCE_ID not set — ingests will fail')

interface IngestMemory {
  content: string
  sourceType: string
  sourceRef?: string
  occurredAt?: string
  locus?: string
  importance?: 'low' | 'normal' | 'high'
  metadata?: Record<string, unknown>
}

interface IngestResult {
  ingested: number
  skipped: number
}

interface ReportPayload {
  itemsPulled: number
  itemsPushed: number
  itemsSkipped: number
  durationMs?: number
  cursorAfter?: unknown
  error?: string
}

export async function ingestMemories(memories: IngestMemory[]): Promise<IngestResult> {
  if (!TOKEN || !INSTANCE_ID) throw new Error('Missing LOCIGRAM_CONNECTOR_TOKEN or LOCIGRAM_INSTANCE_ID')
  if (memories.length === 0) return { ingested: 0, skipped: 0 }

  // Batch in chunks of 50 (API max is 100)
  const results: IngestResult = { ingested: 0, skipped: 0 }
  for (let i = 0; i < memories.length; i += 50) {
    const batch = memories.slice(i, i + 50)
    const res = await fetch(`${LOCIGRAM_URL}/api/connectors/${INSTANCE_ID}/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ memories: batch }),
      signal: AbortSignal.timeout(120_000), // LLM extraction can be slow
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Ingest failed (${res.status}): ${body}`)
    }

    const data = (await res.json()) as IngestResult
    results.ingested += data.ingested
    results.skipped += data.skipped
  }

  return results
}

export async function upsertMemory(content: string, sourceRef: string): Promise<void> {
  await ingestMemories([{
    content,
    sourceType: 'obsidian-note',
    sourceRef,
    locus: 'connectors/obsidian-sync',
  }])
}

export async function reportSync(payload: ReportPayload): Promise<void> {
  if (!TOKEN || !INSTANCE_ID) return

  const res = await fetch(`${LOCIGRAM_URL}/api/connectors/${INSTANCE_ID}/report`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    console.warn(`[obsidian-sync] Report failed (${res.status}): ${await res.text()}`)
  }
}
