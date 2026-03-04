import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { createDb } from '@locigram/db'
import { createVectorClient, ensureCollection, embed, searchSimilar } from '@locigram/vector'
import { startEmbedWorker, defaultPipelineConfig, runNoiseAssessment } from '@locigram/pipeline'
import type { PipelineConfig, LLMConfig } from '@locigram/pipeline'
import { startTruthEngine, runSweep } from '@locigram/truth'
import { buildWebhookRoute } from '@locigram/connector-webhook'
import { palaceMiddleware } from './middleware/palace'
import { authMiddleware } from './middleware/auth'
import { healthRoute } from './routes/health'
import { rememberRoute } from './routes/remember'
import { recallRoute } from './routes/recall'
import { truthsRoute } from './routes/truths'
import { peopleRoute } from './routes/people'
import { timelineRoute } from './routes/timeline'
import { feedbackRoute } from './routes/feedback'
import { bootstrapRoute } from './routes/bootstrap'
import { createMcpHandler } from './mcp/transport'
import { autoRegisterConnectors } from './connectors'

export interface AppConfig {
  databaseUrl: string
  palaceId:    string
  apiToken?:   string
  qdrantUrl:   string
  llm:         LLMConfig
}

export function createApp(config: AppConfig) {
  const db = createDb(config.databaseUrl)

  // Pipeline config — shared across routes and background workers
  const pipelineConfig: PipelineConfig = {
    ...defaultPipelineConfig(),
    palaceId: config.palaceId,
    llm:      config.llm,
  }

  // Vector client — wraps Qdrant + embedding model
  const { client: qdrant } = createVectorClient({
    qdrantUrl:      config.qdrantUrl,
    embeddingUrl:   config.llm.embed.url,
    embeddingModel: config.llm.embed.model,
    embeddingKey:   config.llm.embed.apiKey,
  })

  // Convenience wrapper passed via context
  const vectorClient = {
    embed: (text: string) => embed(text, {
      embeddingUrl:   config.llm.embed.url,
      embeddingModel: config.llm.embed.model,
      embeddingKey:   config.llm.embed.apiKey,
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

  // Auto-register connectors from env vars — no config file needed
  const registry = autoRegisterConnectors()
  console.log(`[app] registered connectors: ${registry.list().join(', ') || 'none (webhook always active)'}`)

  // Start background embed worker (every 30s)
  const stopWorker = startEmbedWorker(db, vectorClient, config.palaceId, 30_000)

  // Start truth engine (every 6 hours)
  const stopTruth = startTruthEngine(db, {
    palaceId:   config.palaceId,
    intervalMs: 6 * 60 * 60 * 1000,
  })

  // Schedule nightly sweep (in-process fallback — K8s CronJob preferred)
  // Only run in-process if LOCIGRAM_DISABLE_INPROCESS_SWEEP is not set
  let stopSweep: (() => void) | undefined
  if (!process.env.LOCIGRAM_DISABLE_INPROCESS_SWEEP) {
    const SWEEP_INTERVAL = 24 * 60 * 60 * 1000  // 24h
    const sweepInterval = setInterval(async () => {
      try {
        await runSweep(db, config.palaceId)
        await runNoiseAssessment(db, config.palaceId, pipelineConfig)
      } catch (err) {
        console.error('[scheduler] sweep failed:', err)
      }
    }, SWEEP_INTERVAL)
    stopSweep = () => clearInterval(sweepInterval)
  }

  const app = new Hono()

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use('*', logger())
  app.use('*', cors())
  app.use('*', palaceMiddleware(db, config.palaceId))
  app.use('*', async (c, next) => {
    c.set('vectorClient', vectorClient)
    c.set('pipelineConfig', pipelineConfig)
    await next()
  })

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
  app.route('/api/webhook',   buildWebhookRoute())
  app.route('/api/bootstrap', bootstrapRoute)

  // ── MCP endpoint (exempt from auth middleware — bearer check inline) ──────
  let mcpHandler: ((req: Request) => Promise<Response>) | null = null

  app.all('/mcp/*', async (c) => {
    if (!mcpHandler) {
      const palace = c.get('palace') as import('@locigram/db').Palace
      mcpHandler = createMcpHandler(db, palace, vectorClient, collectionName, config.apiToken)
    }
    return mcpHandler(c.req.raw)
  })

  // Cleanup on shutdown
  const originalFetch = app.fetch.bind(app)
  return Object.assign(app, {
    stop: () => { stopWorker(); stopTruth(); stopSweep?.() },
    fetch: originalFetch,
  })
}
