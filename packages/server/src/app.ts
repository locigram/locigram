import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { createDb, locigrams } from '@locigram/db'
import { eq } from 'drizzle-orm'
import { createVectorClient, ensureCollection, embed, searchSimilar } from '@locigram/vector'
import { startEmbedWorker, defaultPipelineConfig } from '@locigram/pipeline'
import { startGraphWorker } from './graph/graph-worker'
import { startMentionWorker } from './mention-worker'
import type { PipelineConfig, LLMConfig } from '@locigram/pipeline'
import { startTruthEngine } from '@locigram/truth'
import { startMaintenance } from './maintenance'
import { buildWebhookRoute, buildHealthAutoExportRoute } from '@locigram/connector-webhook'
import { buildStravaWebhookRoute, buildStravaPublicRoute, buildStravaProtectedRoute } from '@locigram/connector-strava'
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
import type { SourceResolverConfig } from './source-resolver'
import type { EnrichmentConfig } from './enrichment'
import { autoRegisterConnectors } from './connectors'
import { metadataRoute, protectedResourceRoute } from './oauth/metadata'
import { clientsRoute } from './oauth/clients'
import { authorizeRoute } from './oauth/authorize'
import { tokenRoute } from './oauth/token'
import { registerRoute } from './oauth/register'
import { activeContextRoute, fleetRoute, heartbeatRoute } from './routes/context'
import { connectorsRoute } from './routes/connectors'
import { startScheduler } from './scheduler'

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

  // Source resolver config — resolves sourceRef strings to original material
  const sourceResolverConfig: SourceResolverConfig = {
    openclawBasePath: process.env.OPENCLAW_BASE_PATH,
    obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH,
    suruDbUrl: process.env.SURU_DATABASE_URL,
  }

  // Enrichment config — controls recall-triggered fact extraction
  const enrichConfig: EnrichmentConfig = {
    enabled: process.env.ENRICHMENT_ENABLED !== 'false',
    maxFactsPerEnrichment: parseInt(process.env.ENRICHMENT_MAX_FACTS ?? '10', 10),
    emailEnrichmentEnabled: process.env.ENRICHMENT_EMAIL === 'true',
  }

  // Auto-register connectors from env vars — no config file needed
  const registry = autoRegisterConnectors({ db, palaceId: config.palaceId })
  console.log(`[app] registered connectors: ${registry.list().join(', ') || 'none (webhook always active)'}`)

  // Start background embed worker (every 30s)
  const stopWorker = startEmbedWorker(db, vectorClient, config.palaceId, 30_000)
  const stopGraphWorker = startGraphWorker(db, config.palaceId, 30_000)
  const stopMentionWorker = startMentionWorker(db, config.palaceId, 60_000)

  // Start truth engine (reinforcement detection + promotion — every 6 hours)
  const stopTruth = startTruthEngine(db, {
    palaceId:   config.palaceId,
    intervalMs: 6 * 60 * 60 * 1000,
  })

  // Start connector scheduler (cron-based per-connector sync)
  const scheduler = startScheduler({ db, palaceId: config.palaceId, pipelineConfig })

  // Start maintenance scheduler (sweep, durability, dedup, cluster, noise)
  // Replaces external K8s CronJobs — all tasks are cron-scheduled in-process
  const stopMaintenance = startMaintenance({ db, palaceId: config.palaceId, pipelineConfig })

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

  // ── OAuth 2.0 (unauthenticated — OAuth handles its own auth) ──────────────
  app.route('/.well-known/oauth-authorization-server', metadataRoute)
  app.route('/.well-known/oauth-protected-resource', protectedResourceRoute)
  app.route('/oauth/authorize', authorizeRoute)
  app.route('/oauth/token', tokenRoute)
  app.route('/oauth/register', registerRoute)

  // ── OAuth client management (protected by palace api_token) ───────────────
  app.route('/oauth/clients', clientsRoute)

  // ── Strava (webhook + OAuth callback — unauthenticated) ────────────────────
  app.route('/api/webhook/strava', buildStravaWebhookRoute())
  app.route('/api/strava', buildStravaPublicRoute())  // /auth + /callback

  // ── Authenticated REST API ─────────────────────────────────────────────────
  app.use('/api/*', authMiddleware)
  app.route('/api/remember',  rememberRoute)
  app.route('/api/recall',    recallRoute)
  app.route('/api/truths',    truthsRoute)
  app.route('/api/people',    peopleRoute)
  app.route('/api/timeline',  timelineRoute)
  app.route('/api/feedback',  feedbackRoute)
  app.route('/api/webhook',   buildWebhookRoute({
    secret: process.env.WEBHOOK_SECRET,
    apiKeys: process.env.WEBHOOK_API_KEYS?.split(',').filter(Boolean),
  }))
  app.route('/api/webhook/hae', buildHealthAutoExportRoute({
    personName: process.env.HEALTH_PERSON_NAME ?? 'Owner',
  }))
  app.route('/api/strava', buildStravaProtectedRoute())  // /athlete + /backfill (authenticated)
  app.route('/api/bootstrap', bootstrapRoute)
  app.route('/api/connectors', connectorsRoute)
  app.route('/api/context/active', activeContextRoute)
  app.route('/api/context/fleet',  fleetRoute)
  app.route('/api/agents',         heartbeatRoute)

  // ── Internal summarize endpoint (used by session-monitor daemon) ───────────
  app.post('/api/internal/summarize', async (c) => {
    const body = await c.req.json()
    const { prompt, maxTokens } = body as { prompt?: string; maxTokens?: number }

    if (!prompt) {
      return c.json({ error: 'prompt is required' }, 400)
    }

    // Wrap prompt to request both narrative + structured JSON in one LLM call
    const wrappedPrompt = [
      prompt,
      '',
      'IMPORTANT: After your narrative summary, output a line containing exactly "---STRUCTURED_JSON---" followed by a JSON object on the next line with these fields:',
      '{ "currentTask": string, "currentProject": string, "pendingActions": string[], "recentDecisions": string[], "blockers": string[], "activeAgents": string[], "domain": "infrastructure"|"coding"|"email"|"business/finance"|"general" }',
      'The domain field should reflect the primary domain of the transcript content.',
      'Output the narrative first, then the separator, then the JSON. Nothing after the JSON.',
    ].join('\n')

    const { url, model, apiKey, noThink } = config.llm.summary
    try {
      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: noThink ? wrappedPrompt + ' /no_think' : wrappedPrompt }],
          max_tokens: maxTokens ?? 2000,
        }),
      })

      const text = await res.text()
      const parsed = JSON.parse(text)
      const content = parsed.choices?.[0]?.message?.content ?? ''
      // Strip <think> tags (Qwen3 native thinking blocks)
      let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      // Strip plain-text thinking blocks — "Thinking Process:" up to first blank line after content
      cleaned = cleaned.replace(/^Thinking Process:[\s\S]*?(?=\n\n[^*\d\s])/m, '').trim()
      // Final fallback: if still starts with "Thinking Process:", strip to first non-bullet paragraph
      if (cleaned.startsWith('Thinking Process:')) {
        const firstRealPara = cleaned.search(/\n\n(?![\s*\d])/)
        if (firstRealPara !== -1) cleaned = cleaned.slice(firstRealPara).trim()
      }

      // Split into narrative + structured
      const separatorIdx = cleaned.indexOf('---STRUCTURED_JSON---')
      let narrative = cleaned
      let structured: Record<string, unknown> | null = null

      if (separatorIdx !== -1) {
        narrative = cleaned.slice(0, separatorIdx).trim()
        const jsonPart = cleaned.slice(separatorIdx + '---STRUCTURED_JSON---'.length).trim()
        try {
          structured = JSON.parse(jsonPart)
        } catch {
          console.warn('[api/internal/summarize] failed to parse structured JSON from LLM output')
        }
      }

      return c.json({ summary: narrative, narrative, structured })
    } catch (err: any) {
      console.error('[api/internal/summarize] LLM call failed:', err.message)
      return c.json({ error: 'LLM call failed', detail: err.message }, 502)
    }
  })

  // ── Session monitor ingest endpoint ────────────────────────────────────────
  app.post('/api/sessions/ingest', async (c) => {
    const body = await c.req.json()
    const { agentName, sessionId, transcript, occurredAt, locus: requestedLocus } = body

    if (!agentName || !sessionId || !transcript) {
      return c.json({ error: 'agentName, sessionId, and transcript are required' }, 400)
    }

    const db     = c.get('db')
    const palace = c.get('palace')

    const snapshotRef = `openclaw:session:${sessionId}:snap:${Date.now()}`

    // Support hierarchical loci: caller can specify a locus like agent/{name}/session/{id}
    // or agent/{name}/context. Legacy callers that don't send locus get agent/{name} (backwards compat).
    const agentLocus = requestedLocus ?? `agent/${agentName}`
    const raw: import('@locigram/core').RawMemory = {
      content:    transcript,
      sourceType: 'llm-session',
      sourceRef:  snapshotRef,
      occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
      locus:      agentLocus,
      metadata:   { agent_name: agentName, session_id: sessionId, connector: 'locigram-session-monitor' },
      preClassified: {
        locus:         agentLocus,
        entities:      [agentName],
        isReference:   false,
        referenceType: null,
        importance:    'normal',
        clientId:      null,
      },
    }

    const { ingest } = await import('@locigram/pipeline')
    const result = await ingest([raw], db, pipelineConfig)

    // Graph write handled by graph-worker (polls graphSyncedAt IS NULL every 30s)

    return c.json(result)
  })

  // ── MCP endpoint (auth middleware resolves token → oauthService) ──────────
  const mcpHandlers = new Map<string, (req: Request) => Promise<Response>>()

  function getMcpHandler(palace: import('@locigram/db').Palace, oauthService: string | null) {
    const key = oauthService ?? '__master__'
    let handler = mcpHandlers.get(key)
    if (!handler) {
      handler = createMcpHandler(db, palace, vectorClient, collectionName, oauthService, sourceResolverConfig, enrichConfig)
      mcpHandlers.set(key, handler)
    }
    return handler
  }

  const handleMcp = async (c: any) => {
    const palace = c.get('palace') as import('@locigram/db').Palace
    const oauthService = c.get('oauthService') as string | null ?? null
    const handler = getMcpHandler(palace, oauthService)

    // Claude.ai sends Accept: application/json only — MCP SDK requires text/event-stream too.
    // Patch the request headers so the transport doesn't 406.
    let req = c.req.raw
    const accept = req.headers.get('Accept') ?? ''
    if (!accept.includes('text/event-stream')) {
      const newHeaders = new Headers(req.headers)
      newHeaders.set('Accept', accept ? `${accept}, text/event-stream` : 'application/json, text/event-stream')
      req = new Request(req, { headers: newHeaders })
    }

    return handler(req)
  }

  app.all('/mcp/*', authMiddleware, handleMcp)
  app.all('/mcp', authMiddleware, handleMcp)
  // Root path — Claude.ai uses the base URL directly as the MCP endpoint
  app.all('/', authMiddleware, handleMcp)

  // Cleanup on shutdown
  const originalFetch = app.fetch.bind(app)
  return Object.assign(app, {
    stop: () => { stopWorker(); stopGraphWorker(); stopMentionWorker(); stopTruth(); stopMaintenance(); scheduler.stop() },
    fetch: originalFetch,
  })
}
