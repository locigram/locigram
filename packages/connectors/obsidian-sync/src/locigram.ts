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
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
  if (json.error) {
    if (json.error.code === -32600 || json.error.message?.includes('initialize')) {
      return { needsInit: true }
    }
    throw new Error(json.error.message)
  }
  return json.result
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'obsidian-sync', version: '0.1.0' },
  })
  await rpc('notifications/initialized', {})
  initialized = true
}

export async function upsertMemory(
  content: string,
  locus: string,
  sourceRef: string,
): Promise<void> {
  const params = {
    name: 'memory_remember',
    arguments: {
      content,
      locus,
      sourceType: 'sync',
      connector: 'obsidian-sync',
      source_ref: sourceRef,
    },
  }

  try {
    const result = await rpc('tools/call', params) as Record<string, unknown>
    if (result?.needsInit) {
      await ensureInitialized()
      await rpc('tools/call', params)
    }
  } catch (err) {
    if (!initialized) {
      try {
        await ensureInitialized()
        await rpc('tools/call', params)
        return
      } catch (retryErr) {
        console.error(`[obsidian-sync] MCP retry failed for ${sourceRef}: ${retryErr}`)
        return
      }
    }
    console.error(`[obsidian-sync] MCP failed for ${sourceRef}: ${err}`)
  }
}
