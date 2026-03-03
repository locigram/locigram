import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createDb } from '@locigram/db'
import { palaceMiddleware } from './middleware/palace'
import { authMiddleware } from './middleware/auth'
import { healthRoute } from './routes/health'
import { rememberRoute } from './routes/remember'
import { recallRoute } from './routes/recall'
import { truthsRoute } from './routes/truths'
import { peopleRoute } from './routes/people'
import { timelineRoute } from './routes/timeline'
import { feedbackRoute } from './routes/feedback'
import { buildTools } from './mcp/tools'

interface AppConfig {
  databaseUrl: string
  palaceId: string
  apiToken?: string
}

export function createApp(config: AppConfig) {
  const db = createDb(config.databaseUrl)
  const app = new Hono()

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use('*', logger())
  app.use('*', cors())
  app.use('*', palaceMiddleware(db, config.palaceId))

  // ── Unauthenticated ────────────────────────────────────────────────────────
  app.route('/api/health', healthRoute)

  // ── Authenticated REST API ─────────────────────────────────────────────────
  app.use('/api/*', authMiddleware)
  app.route('/api/remember',  rememberRoute)
  app.route('/api/recall',    recallRoute)
  app.route('/api/truths',    truthsRoute)
  app.route('/api/people',    peopleRoute)
  app.route('/api/timeline',  timelineRoute)
  app.route('/api/feedback',  feedbackRoute)

  // ── MCP endpoint ───────────────────────────────────────────────────────────
  // Mounted at /mcp — Streamable HTTP transport
  // Tools are registered after palace is resolved on first request
  app.all('/mcp/*', async (c) => {
    const palace = c.get('palace')
    const tools = buildTools(db, palace)

    const mcpServer = new McpServer({
      name: `locigram-${palace.id}`,
      version: '0.1.0',
    })

    for (const [name, tool] of Object.entries(tools)) {
      mcpServer.tool(name, tool.description, tool.schema.shape ?? {}, tool.handler)
    }

    // TODO: wire @hono/mcp transport when package stabilizes
    return c.json({ error: 'MCP transport coming soon' }, 501)
  })

  return app
}
