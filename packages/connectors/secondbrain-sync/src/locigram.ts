const MCP_URL = process.env.LOCIGRAM_MCP_URL ?? 'http://locigram-server.locigram-main:3000/mcp'
const TOKEN = process.env.LOCIGRAM_TOKEN ?? ''

let requestId = 0
let initialized = false

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

async function rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = ++requestId
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`)
  }

  return (await res.json()) as JsonRpcResponse
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'secondbrain-sync', version: '0.1.0' },
  })
  await rpc('notifications/initialized', {})
  initialized = true
}

export async function rememberMemory(
  content: string,
  _locus: string,  // kept for API compat but ignored — server auto-scopes to connectors/secondbrain-sync
  sourceRef: string,
): Promise<void> {
  const params = {
    name: 'memory_remember',
    arguments: {
      content,
      sourceType: 'sync',
      connector: 'secondbrain-sync',
      source_ref: sourceRef,
      // locus omitted — server auto-scopes to connectors/secondbrain-sync
    },
  }

  try {
    const res = await rpc('tools/call', params)
    if (res.error) {
      // If server requires initialize handshake, do it and retry
      if (res.error.code === -32600 || res.error.message?.includes('initialize')) {
        await ensureInitialized()
        const retry = await rpc('tools/call', params)
        if (retry.error) {
          console.error(`[secondbrain-sync] MCP retry failed: ${retry.error.message}`)
        }
        return
      }
      console.error(`[secondbrain-sync] MCP error: ${res.error.message}`)
    }
  } catch (err) {
    // Try initialize handshake and retry once
    if (!initialized) {
      try {
        await ensureInitialized()
        const retry = await rpc('tools/call', params)
        if (retry.error) {
          console.error(`[secondbrain-sync] MCP retry failed: ${retry.error.message}`)
        }
        return
      } catch (retryErr) {
        console.error(`[secondbrain-sync] MCP retry failed: ${retryErr}`)
        return
      }
    }
    console.error(`[secondbrain-sync] MCP call failed: ${err}`)
  }
}
