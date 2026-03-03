import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { createDb } from '@locigram/db'
import { createVectorClient, ensureCollection, embed, searchSimilar } from '@locigram/vector'
import { startEmbedWorker } from '@locigram/pipeline'
import { startTruthEngine } from '@locigram/truth'
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

export interface AppConfig {
  databaseUrl:    string
  palaceId:       string
  apiToken?:      string
  qdrantUrl:      string
  embeddingUrl:   string
  embeddingModel: string
}

export function createApp(config: AppConfig) {
  const db = createDb(config.databaseUrl)

  // Vector client — wraps Qdrant + embedding model
  const { client: qdrant } = createVectorClient({
    qdrantUrl:      config.qdrantUrl,
    embeddingUrl:   config.embeddingUrl,
    embeddingModel: config.embeddingModel,
  })

  // Convenience wrapper passed via context
  const vectorClient = {
    embed: (text: string) => embed(text, {
      embeddingUrl:   config.embeddingUrl,
      embeddingModel: config.embeddingModel,
    }),
    search: (collection: string, vector: number[], opts: object) =>
      searchSimilar(qdrant, collection, vector, opts as any),
    upsert: async (collection: string, id: string, vector: number[], payload: object) => {
      const { upsertEmbedding } = await import('@locigram/vector')
      await upsertEmbedding(qdrant, collection, id, vector, payload as any)
    },
  }

  // Ensure Qdrant collection exists for this palace
  const collectionName = `locigrams-${config.palaceId}`
  ensureCollection(qdrant, collectionName).catch(err =>
    console.error('[app] failed to ensure Qdrant collection:', err)
  )

  // Start background embed worker (every 30s)
  const stopWorker = startEmbedWorker(db, vectorClient, config.palaceId, 30_000)

  // Start truth engine (every 6 hours)
  const stopTruth = startTruthEngine(db, {
    palaceId:   config.palaceId,
    intervalMs: 6 * 60 * 60 * 1000,
  })

  const app = new Hono()

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use('*', logger())
  app.use('*', cors())
  app.use('*', palaceMiddleware(db, config.palaceId))
  app.use('*', async (c, next) => {
    c.set('vectorClient', vectorClient)
    await next()
  })

  // ── Unauthenticated ────────────────────────────────────────────────────────
  app.route('/api/health', healthRoute)

  // ── Authenticated REST API ─────────────────────────────────────────────────
  app.use('/api/*', authMiddleware)
  app.route('/api/remember', rememberRoute)
  app.route('/api/recall',   recallRoute)
  app.route('/api/truths',   truthsRoute)
  app.route('/api/people',   peopleRoute)
  app.route('/api/timeline', timelineRoute)
  app.route('/api/feedback', feedbackRoute)

  // ── MCP endpoint ───────────────────────────────────────────────────────────
  app.all('/mcp/*', async (c) => {
    const palace = c.get('palace')
    const tools  = buildTools(db, palace)
    // TODO: wire @hono/mcp transport
    return c.json({ palace: palace.id, tools: Object.keys(tools) })
  })

  // Cleanup on shutdown
  const originalFetch = app.fetch.bind(app)
  return Object.assign(app, {
    stop: () => { stopWorker(); stopTruth() },
    fetch: originalFetch,
  })
}
