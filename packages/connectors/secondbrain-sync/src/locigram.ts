const MCP_URL = process.env.LOCIGRAM_MCP_URL ?? 'http://locigram-server.locigram-main:3000/mcp'
const TOKEN = process.env.LOCIGRAM_TOKEN ?? ''

let requestId = 0
let sessionId: string | null = null

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

async function rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = ++requestId
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  }

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`)
  }

  // Capture session ID from initialize response
  const newSessionId = res.headers.get('mcp-session-id')
  if (newSessionId) {
    sessionId = newSessionId
  }

  return (await res.json()) as JsonRpcResponse
}

async function initialize(): Promise<void> {
  sessionId = null // reset before new session
  const res = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'secondbrain-sync', version: '0.1.0' },
  })
  if (res.error) throw new Error(`MCP initialize failed: ${res.error.message}`)
  await rpc('notifications/initialized', {})
}

export async function rememberMemory(
  content: string,
  _locus: string, // kept for API compat — server auto-scopes to connectors/secondbrain-sync
  sourceRef: string,
): Promise<void> {
  // Initialize session on first call
  if (!sessionId) {
    try {
      await initialize()
    } catch (err) {
      console.error(`[secondbrain-sync] MCP initialize failed: ${err}`)
      return
    }
  }

  const params = {
    name: 'memory_remember',
    arguments: {
      content,
      sourceType: 'sync',
      connector: 'secondbrain-sync',
      source_ref: sourceRef,
    },
  }

  try {
    const res = await rpc('tools/call', params)
    if (res.error) {
      // Session expired — re-initialize and retry once
      if (res.error.message?.includes('initialize') || res.error.message?.includes('not initialized')) {
        await initialize()
        const retry = await rpc('tools/call', params)
        if (retry.error) console.error(`[secondbrain-sync] MCP retry failed: ${retry.error.message}`)
      } else {
        console.error(`[secondbrain-sync] MCP error: ${res.error.message}`)
      }
    }
  } catch (err) {
    console.error(`[secondbrain-sync] MCP call failed: ${err}`)
  }
}
