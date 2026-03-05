const MCP_URL = process.env.LOCIGRAM_MCP_URL ?? 'http://10.10.100.82:30310/mcp'
const TOKEN = process.env.LOCIGRAM_TOKEN ?? ''

let initialized = false
let requestId = 0

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = ++requestId
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'obsidian-audit', version: '0.1.0' },
  })
  await rpc('notifications/initialized', {})
  initialized = true
}

export async function getLocigrmaCoverage(): Promise<string> {
  try {
    await ensureInitialized()
    const result = await rpc('tools/call', {
      name: 'memory_session_start',
      arguments: { locus: 'agent/main', lookbackDays: 30 },
    }) as { content?: Array<{ text?: string }> }
    return result?.content?.[0]?.text ?? ''
  } catch (err) {
    console.warn(`[obsidian-audit] Could not fetch Locigram coverage: ${err}`)
    return ''
  }
}
