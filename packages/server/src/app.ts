import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { createDb, locigrams } from '@locigram/db'
import { eq } from 'drizzle-orm'
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
import { metadataRoute, protectedResourceRoute } from './oauth/metadata'
import { clientsRoute } from './oauth/clients'
import { authorizeRoute } from './oauth/authorize'
import { tokenRoute } from './oauth/token'
import { activeContextRoute, fleetRoute, heartbeatRoute } from './routes/context'

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
  const registry = autoRegisterConnectors({ db, palaceId: config.palaceId })
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

  // ── OAuth 2.0 (unauthenticated — OAuth handles its own auth) ──────────────
  app.route('/.well-known/oauth-authorization-server', metadataRoute)
  app.route('/.well-known/oauth-protected-resource', protectedResourceRoute)
  app.route('/oauth/authorize', authorizeRoute)
  app.route('/oauth/token', tokenRoute)

  // ── OAuth client management (protected by palace api_token) ───────────────
  app.route('/oauth/clients', clientsRoute)

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
          messages: [{ role: 'user', content: wrappedPrompt + ' /no_think' }],
          max_tokens: maxTokens ?? 1200,
        }),
      })

      const text = await res.text()
      const parsed = JSON.parse(text)
      const content = parsed.choices?.[0]?.message?.content ?? ''
      let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      // Strip plain-text thinking blocks (models that don't use <think> tags)
      const domainMarker = cleaned.indexOf('**Domain:**')
      if (domainMarker > 0) {
        cleaned = cleaned.slice(domainMarker)
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

    // Fire-and-forget graph write — fetch real UUID then write to Memgraph
    if (result.stored > 0) {
      const { writeMemoryToGraph } = await import('./graph/graph-write')
      db.select({ id: locigrams.id })
        .from(locigrams)
        .where(eq(locigrams.sourceRef, snapshotRef))
        .limit(1)
        .then(([row]) => {
          if (!row) return
          return writeMemoryToGraph({
            id: row.id,
            palaceId: palace.id,
            locus: agentLocus,
            sourceType: 'llm-session',
            agentName,
            sessionId,
            importance: 'normal',
            occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
            connector: 'locigram-session-monitor',
          })
        })
        .catch(e => console.warn('[graph] ingest write failed:', e))
    }

    return c.json(result)
  })

  // ── MCP endpoint (exempt from auth middleware — bearer check inline) ──────
  let mcpHandler: ((req: Request) => Promise<Response>) | null = null

  // MCP handler mounted at both /mcp/* (explicit) and /* (root — for clients that use base URL directly)
  const handleMcp = async (c: any) => {
    if (!mcpHandler) {
      const palace = c.get('palace') as import('@locigram/db').Palace
      mcpHandler = createMcpHandler(db, palace, vectorClient, collectionName, config.apiToken)
    }
    return mcpHandler(c.req.raw)
  }
  app.all('/mcp/*', handleMcp)
  app.all('/mcp', handleMcp)
  // Root path — Claude.ai uses the base URL directly as the MCP endpoint
  app.all('/', handleMcp)

  // Cleanup on shutdown
  const originalFetch = app.fetch.bind(app)
  return Object.assign(app, {
    stop: () => { stopWorker(); stopTruth(); stopSweep?.() },
    fetch: originalFetch,
  })
}
