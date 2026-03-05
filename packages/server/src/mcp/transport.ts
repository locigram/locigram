import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildTools, type VectorOps } from './tools'
import type { DB, Palace } from '@locigram/db'

// ── Session management ───────────────────────────────────────────────────────

interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  timer: ReturnType<typeof setTimeout>
}

const SESSION_TTL = 30 * 60 * 1000 // 30 minutes

// ── Internal: register tools on McpServer ────────────────────────────────────

type ToolMap = ReturnType<typeof buildTools>

function registerTools(mcp: McpServer, tools: ToolMap) {
  for (const [name, tool] of Object.entries(tools)) {
    const shape = 'shape' in tool.schema ? (tool.schema as any).shape : {}

    mcp.registerTool(name, { description: tool.description, inputSchema: shape }, async (args: any) => {
      try {
        const result = await tool.handler(args)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }],
          isError: true,
        }
      }
    })
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a request handler for MCP over Streamable HTTP.
 * Tools are registered once; sessions are managed per-client with a 30-min TTL.
 */
export function createMcpHandler(
  db: DB,
  palace: Palace,
  vectorClient: VectorOps,
  collection: string,
  oauthService?: string | null,
): (req: Request) => Promise<Response> {
  const tools = buildTools(db, palace, vectorClient, collection, oauthService)
  const sessions = new Map<string, Session>()

  function cleanupSession(sessionId: string) {
    const session = sessions.get(sessionId)
    if (session) {
      clearTimeout(session.timer)
      sessions.delete(sessionId)
      session.transport.close()
    }
  }

  return async (req: Request): Promise<Response> => {
    const sessionId = req.headers.get('mcp-session-id')

    // Route to existing session
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!
      clearTimeout(session.timer)
      session.timer = setTimeout(() => cleanupSession(sessionId), SESSION_TTL)
      return session.transport.handleRequest(req)
    }

    // New session — create transport + server
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        sessions.set(sid, {
          transport,
          timer: setTimeout(() => cleanupSession(sid), SESSION_TTL),
        })
      },
      onsessionclosed: (sid) => cleanupSession(sid),
    })

    const mcp = new McpServer(
      { name: 'locigram', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    registerTools(mcp, tools)
    await mcp.connect(transport)
    return transport.handleRequest(req)
  }
}
