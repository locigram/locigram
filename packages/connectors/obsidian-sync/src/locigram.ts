const MCP_URL = process.env.LOCIGRAM_MCP_URL ?? 'http://10.10.100.82:30310/mcp'
const TOKEN = process.env.LOCIGRAM_TOKEN ?? ''

let requestId = 0
let sessionId: string | null = null

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = ++requestId
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`)

  const newSid = res.headers.get('mcp-session-id')
  if (newSid) sessionId = newSid

  const json = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result
}

async function ensureSession(): Promise<void> {
  if (sessionId) return
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'obsidian-sync', version: '0.1.0' },
  })
  await rpc('notifications/initialized', {})
}

export async function upsertMemory(
  content: string,
  sourceRef: string,
): Promise<void> {
  if (!sessionId) {
    try { await ensureSession() } catch (err) {
      console.error(`[obsidian-sync] MCP init failed: ${err}`)
      return
    }
  }

  const params = {
    name: 'memory_remember',
    arguments: {
      content,
      sourceType: 'sync',
      connector: 'obsidian-sync',
      source_ref: sourceRef,
    },
  }

  try {
    await rpc('tools/call', params)
  } catch (err) {
    // Re-init and retry once if session expired
    try {
      sessionId = null
      await ensureSession()
      await rpc('tools/call', params)
    } catch (retryErr) {
      console.error(`[obsidian-sync] MCP failed for ${sourceRef}: ${retryErr}`)
    }
  }
}
