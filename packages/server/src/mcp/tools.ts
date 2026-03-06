import { z } from 'zod'
import { locigrams, truths, entities, connectorInstances, connectorSyncs } from '@locigram/db'
import { eq, and, gte, desc, sql, isNull, inArray, or, like } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import type { Palace } from '@locigram/db'
import type { SearchOptions, SearchResult } from '@locigram/vector'
import { runQueryWithResult } from '../graph/graph-client'


// ── Vector operations interface ──────────────────────────────────────────────

export interface VectorOps {
  embed:  (text: string) => Promise<number[]>
  search: (collection: string, vector: number[], opts: SearchOptions) => Promise<SearchResult[]>
  upsert: (collection: string, id: string, vector: number[], payload: Record<string, unknown>) => Promise<void>
}

// ── Tool builder ─────────────────────────────────────────────────────────────

export function buildTools(db: DB, palace: Palace, vector: VectorOps, collection: string, oauthService?: string | null) {
  const palaceId = palace.id

  return {

    memory_recall: {
      description: 'Semantically search memories in the palace. Returns the most relevant locigrams for a given query.',
      schema: z.object({
        query:  z.string().describe('What to search for'),
        locus:  z.string().optional().describe('Namespace filter e.g. people/, business/, project/locigram'),
        limit:  z.number().int().min(1).max(20).default(10).describe('Max results'),
      }),
      handler: async ({ query, locus, limit }: { query: string; locus?: string; limit: number }) => {
        const queryVector = await vector.embed(query)
        const results = await vector.search(collection, queryVector, { palaceId, locus, limit })

        if (results.length === 0) return { results: [], query }

        const ids = results.map(r => r.id)
        const rows = await db.select().from(locigrams)
          .where(and(eq(locigrams.palaceId, palaceId), inArray(locigrams.id, ids)))

        const rowMap = new Map(rows.map(r => [r.id, r]))
        const merged = results
          .map(r => ({ ...rowMap.get(r.id), score: r.score }))
          .filter(r => 'id' in r)

        return { results: merged, query }
      },
    },

    memory_remember: {
      description: 'Store a new memory in the palace. When called from an external LLM service (Claude.ai, ChatGPT, Gemini, etc.), pass sourceType="llm-session" and service="<serviceName>" to automatically scope to the correct sessions/<service> locus. When called from an internal sync connector (obsidian-sync, secondbrain-sync, etc.), pass connector="<connectorName>" and sourceType="sync" to auto-scope to connectors/<connector>.',
      schema: z.object({
        content:    z.string().describe('The memory to store in plain language'),
        locus:      z.string().default('personal/general').describe('Namespace e.g. people/alice, project/locigram'),
        entities:   z.array(z.string()).default([]).describe('Named entities mentioned'),
        sourceType: z.enum(['manual','llm-session','email','sms','chat','webhook','system','sync']).default('llm-session'),
        service:    z.enum(['claude', 'chatgpt', 'gemini', 'perplexity', 'copilot', 'grok', 'mistral', 'llama', 'other']).optional().describe('The LLM service this memory originates from. When provided with sourceType=llm-session, auto-scopes locus to sessions/<service> unless locus is explicitly set by caller.'),
        connector:  z.string().optional().describe('Internal sync connector name (e.g. obsidian-sync, secondbrain-sync). When provided with sourceType=sync, auto-scopes locus to connectors/<connector> unless locus is explicitly set by caller.'),
        source_ref: z.string().optional().describe('Unique source reference for upsert deduplication (e.g. obsidian:Infrastructure/MCP-Servers.md, surudb:client:7).'),
      }),
      handler: async ({ content, locus, entities: ents, sourceType, service: modelService, connector: connectorName, source_ref: sourceRef }: any) => {
        // oauthService (from verified auth) takes precedence over model-provided service
        const service = oauthService ?? modelService ?? null

        // Resolve locus: service-scoped for LLM sessions, connector-scoped for sync jobs
        let resolvedLocus = locus
        if (service && sourceType === 'llm-session' && locus === 'personal/general') {
          resolvedLocus = `sessions/${service}`
        } else if (connectorName && sourceType === 'sync' && locus === 'personal/general') {
          resolvedLocus = `connectors/${connectorName}`
        }

        // Upsert by source_ref if provided (update existing rather than insert duplicate)
        if (sourceRef) {
          const [existing] = await db.select().from(locigrams)
            .where(and(eq(locigrams.palaceId, palaceId), eq(locigrams.sourceRef, sourceRef)))
            .limit(1)

          if (existing) {
            const [updated] = await db.update(locigrams)
              .set({ content, locus: resolvedLocus, entities: ents, sourceType, metadata: { service: service ?? null, connector: connectorName ?? null } })
              .where(eq(locigrams.id, existing.id))
              .returning()

            const vec = await vector.embed(content)
            await vector.upsert(collection, updated.id, vec, {
              palace_id: palaceId,
              locus: resolvedLocus,
              source_type: sourceType,
              service: service ?? null,
              connector: connectorName ?? 'mcp',
              entities: ents,
              confidence: 1.0,
              created_at: updated.createdAt.toISOString(),
            })
            return { id: updated.id, status: 'updated' }
          }
        }

        const [loc] = await db.insert(locigrams).values({
          content, locus: resolvedLocus, entities: ents, sourceType, confidence: 1.0,
          metadata: { service: service ?? null, connector: connectorName ?? null },
          ...(sourceRef ? { sourceRef } : {}),
          palaceId,
        }).returning()

        const vec = await vector.embed(content)
        await vector.upsert(collection, loc.id, vec, {
          palace_id: palaceId,
          locus: resolvedLocus,
          source_type: sourceType,
          service: service ?? null,
          connector: connectorName ?? 'mcp',
          entities: ents,
          confidence: 1.0,
          created_at: loc.createdAt.toISOString(),
        })

        await db.update(locigrams)
          .set({ embeddingId: loc.id, tier: 'hot' })
          .where(eq(locigrams.id, loc.id))

        // Graph write handled by graph-worker (polls graphSyncedAt IS NULL every 30s)
        return { id: loc.id, status: 'stored' }
      },
    },

    memory_context: {
      description: 'Surface the most relevant recent memories for the current context. No locus filter — hybrid recency + score ranking.',
      schema: z.object({
        context: z.string().describe('Current topic or task for context'),
        limit:   z.number().int().default(5),
      }),
      handler: async ({ context, limit }: { context: string; limit: number }) => {
        const queryVector = await vector.embed(context)
        const results = await vector.search(collection, queryVector, { palaceId, limit: limit * 2 })

        if (results.length === 0) {
          const rows = await db.select().from(locigrams)
            .where(and(eq(locigrams.palaceId, palaceId), isNull(locigrams.expiresAt)))
            .orderBy(desc(locigrams.createdAt))
            .limit(limit)
          return { results: rows }
        }

        const ids = results.map(r => r.id)
        const rows = await db.select().from(locigrams)
          .where(and(eq(locigrams.palaceId, palaceId), inArray(locigrams.id, ids), isNull(locigrams.expiresAt)))

        const scoreMap = new Map(results.map(r => [r.id, r.score]))
        const merged = rows
          .map(r => {
            const similarity = scoreMap.get(r.id) ?? 0
            const ageHours = (Date.now() - r.createdAt.getTime()) / (1000 * 60 * 60)
            const recencyBoost = Math.max(0, 1 - ageHours / (24 * 7))
            return { ...r, score: similarity * 0.7 + recencyBoost * 0.3 }
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)

        return { results: merged }
      },
    },

    people_lookup: {
      description: 'Get a full profile for a person — all memories and facts about them.',
      schema: z.object({
        name: z.string().describe('Person name or alias'),
      }),
      handler: async ({ name }: { name: string }) => {
        const [entity] = await db.select().from(entities)
          .where(and(eq(entities.palaceId, palaceId), eq(entities.name, name)))
          .limit(1)

        const memories = await db.select().from(locigrams)
          .where(and(
            eq(locigrams.palaceId, palaceId),
            sql`${locigrams.entities} @> ARRAY[${name}]::text[]`
          ))
          .orderBy(desc(locigrams.createdAt))
          .limit(20)

        return { entity: entity ?? null, memories, total: memories.length }
      },
    },

    truth_get: {
      description: 'Get high-confidence facts (truths) about a topic or locus.',
      schema: z.object({
        locus:         z.string().optional().describe('Namespace filter'),
        minConfidence: z.number().min(0).max(1).default(0.7),
        limit:         z.number().int().default(10),
      }),
      handler: async ({ minConfidence, limit }: any) => {
        const results = await db.select().from(truths)
          .where(and(eq(truths.palaceId, palaceId), gte(truths.confidence, minConfidence)))
          .orderBy(desc(truths.confidence))
          .limit(limit)
        return { results, total: results.length }
      },
    },

    recent_activity: {
      description: 'Browse recent memories by time window or locus.',
      schema: z.object({
        hours: z.number().int().default(24).describe('Look back window in hours'),
        locus: z.string().optional(),
        limit: z.number().int().default(20),
      }),
      handler: async ({ hours, limit }: { hours: number; locus?: string; limit: number }) => {
        const since = new Date(Date.now() - hours * 60 * 60 * 1000)
        const results = await db.select().from(locigrams)
          .where(and(eq(locigrams.palaceId, palaceId), gte(locigrams.createdAt, since)))
          .orderBy(desc(locigrams.createdAt))
          .limit(limit)
        return { results, since: since.toISOString(), total: results.length }
      },
    },

    palace_stats: {
      description: 'Get stats about this palace — locigram count, truth count, top entities.',
      schema: z.object({}),
      handler: async () => {
        const [{ count: locigramCount }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(locigrams).where(eq(locigrams.palaceId, palaceId))

        const [{ count: truthCount }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(truths).where(eq(truths.palaceId, palaceId))

        return {
          palace: { id: palaceId, name: palace.name },
          stats: { locigramCount, truthCount },
        }
      },
    },

    // ── New tools ──────────────────────────────────────────────────────────────

    memory_client: {
      description: 'Get all memories for a specific client. Business use case: pull everything known about a client or account.',
      schema: z.object({
        clientId: z.string().describe('Client ID'),
        limit:    z.number().int().default(20),
        locus:    z.string().optional().describe('Optional locus prefix filter'),
      }),
      handler: async ({ clientId, limit, locus }: { clientId: string; limit: number; locus?: string }) => {
        const conditions = [
          eq(locigrams.palaceId, palaceId),
          eq(locigrams.clientId, clientId),
          isNull(locigrams.expiresAt),
        ]
        if (locus) conditions.push(like(locigrams.locus, `${locus}%`))

        const results = await db.select().from(locigrams)
          .where(and(...conditions))
          .orderBy(sql`${locigrams.accessScore} DESC NULLS LAST`, desc(locigrams.createdAt))
          .limit(limit)

        return { results, total: results.length }
      },
    },

    memory_reference: {
      description: 'Look up reference data — stable facts like contracts, contacts, configurations, software versions. Precise lookup, not semantic.',
      schema: z.object({
        query:         z.string().describe('What to look up'),
        referenceType: z.enum(['network_device','software','configuration','service_account','contract','contact']).optional(),
        limit:         z.number().int().default(10),
      }),
      handler: async ({ query, referenceType, limit }: { query: string; referenceType?: string; limit: number }) => {
        const queryVector = await vector.embed(query)
        const searchResults = await vector.search(collection, queryVector, { palaceId, limit: limit * 3 })

        if (searchResults.length === 0) return { results: [] }

        const ids = searchResults.map(r => r.id)
        const conditions = [
          eq(locigrams.palaceId, palaceId),
          inArray(locigrams.id, ids),
          eq(locigrams.isReference, true),
          isNull(locigrams.expiresAt),
        ]
        if (referenceType) conditions.push(eq(locigrams.referenceType, referenceType))

        const rows = await db.select().from(locigrams)
          .where(and(...conditions))
          .limit(limit)

        const scoreMap = new Map(searchResults.map(r => [r.id, r.score]))
        const merged = rows
          .map(r => ({ ...r, score: scoreMap.get(r.id) ?? 0 }))
          .sort((a, b) => b.score - a.score)

        return { results: merged }
      },
    },

    memory_forget: {
      description: 'Mark a memory as expired. Use when something is no longer true or has been superseded.',
      schema: z.object({
        id: z.string().uuid().describe('UUID of the locigram to forget'),
      }),
      handler: async ({ id }: { id: string }) => {
        const [updated] = await db.update(locigrams)
          .set({ expiresAt: sql`NOW()` })
          .where(and(eq(locigrams.id, id), eq(locigrams.palaceId, palaceId)))
          .returning({ id: locigrams.id })

        if (!updated) return { error: 'not found' }
        return { id: updated.id, status: 'forgotten' }
      },
    },

    memory_session_start: {
      description: 'Called at session start or after compaction. Returns recent decisions, active context, and high-importance items. Pass locus for agent context (e.g. agent/main). Pass service to also include memories from sessions/<service> (for external LLM sessions like ChatGPT, Gemini, etc.).',
      schema: z.object({
        locus:        z.string().optional().describe('Agent locus filter e.g. agent/main, agent/watcher, agent/msp'),
        lookbackDays: z.number().int().default(7),
        service:      z.enum(['claude', 'chatgpt', 'gemini', 'perplexity', 'copilot', 'grok', 'mistral', 'llama', 'other']).optional().describe('When provided, also includes memories from sessions/<service> locus in the context window.'),
      }),
      handler: async ({ locus, lookbackDays, service }: { locus?: string; lookbackDays: number; service?: string }) => {
        const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)

        const memConditions = [
          eq(locigrams.palaceId, palaceId),
          gte(locigrams.createdAt, since),
          isNull(locigrams.expiresAt),
          or(like(locigrams.locus, 'agent/%'), eq(locigrams.importance, 'high')),
          // exclude heartbeats — just alive pings, not useful for context recovery
          sql`${locigrams.locus} NOT LIKE '%/heartbeat'`,
        ]
        if (locus) memConditions.push(like(locigrams.locus, `${locus}/%`))

        const recentMemories = await db.select().from(locigrams)
          .where(and(...memConditions))
          .orderBy(desc(locigrams.importance), desc(locigrams.createdAt))
          .limit(20)

        const recentTruths = await db.select().from(truths)
          .where(and(eq(truths.palaceId, palaceId), gte(truths.createdAt, since)))
          .orderBy(desc(truths.confidence))
          .limit(5)

        // GraphRAG: hop from known memory IDs through the graph to find
        // structurally related memories (same session, same agent, same locus path)
        // that the flat Postgres query might have missed (e.g. older but connected)
        let graphMemories: typeof recentMemories = []
        try {
          const knownIds = recentMemories.map(m => m.id)
          const agentName = locus ? locus.split('/')[1] : undefined

          if (agentName) {
            // Traverse: Agent -> Sessions -> all Memories in those sessions
            const graphRows = await runQueryWithResult<{ id: string }>(
              `MATCH (a:Agent {name: $agentName})<-[:RUN_BY]-(s:Session)<-[:PART_OF]-(m:Memory)
               WHERE NOT m.id IN $knownIds
               RETURN DISTINCT m.id AS id
               LIMIT 10`,
              { agentName, knownIds }
            )

            if (graphRows.length > 0) {
              const graphIds = graphRows.map(r => r.id)
              const extra = await db.select().from(locigrams)
                .where(and(
                  eq(locigrams.palaceId, palaceId),
                  isNull(locigrams.expiresAt),
                  inArray(locigrams.id, graphIds),
                ))
              graphMemories = extra
            }
          }
        } catch (e) {
          console.warn('[graph] memory_session_start traversal failed:', e)
        }

        // If service provided, also pull recent memories from sessions/<service>
        let serviceMemories: typeof recentMemories = []
        if (service) {
          const serviceConditions = [
            eq(locigrams.palaceId, palaceId),
            gte(locigrams.createdAt, since),
            isNull(locigrams.expiresAt),
            like(locigrams.locus, `sessions/${service}%`),
          ]
          serviceMemories = await db.select().from(locigrams)
            .where(and(...serviceConditions))
            .orderBy(desc(locigrams.createdAt))
            .limit(10)
        }

        // Deduplicate by id before returning
        const seen = new Set<string>()
        const allMemories = [...recentMemories, ...graphMemories, ...serviceMemories].filter(m => {
          if (seen.has(m.id)) return false
          seen.add(m.id)
          return true
        })

        return {
          recentMemories: allMemories,
          truths: recentTruths,
          graphEnriched: graphMemories.length > 0,
          summary: `Found ${recentMemories.length} recent memories${graphMemories.length > 0 ? ` + ${graphMemories.length} graph-connected` : ''}${serviceMemories.length > 0 ? ` + ${serviceMemories.length} from sessions/${service}` : ''} and ${recentTruths.length} truths from the last ${lookbackDays} days.`,
        }
      },
    },

    memory_correct: {
      description: 'Correct a wrong or outdated memory. Creates a new memory and marks the old one as superseded. Immutable audit trail — nothing is deleted.',
      schema: z.object({
        oldId:      z.string().uuid().describe('UUID of the locigram being corrected'),
        correction: z.string().describe('The correct information'),
        locus:      z.string().optional().describe('Override locus (defaults to same as old memory)'),
      }),
      handler: async ({ oldId, correction, locus }: { oldId: string; correction: string; locus?: string }) => {
        const [old] = await db.select().from(locigrams)
          .where(and(eq(locigrams.id, oldId), eq(locigrams.palaceId, palaceId)))
          .limit(1)

        if (!old) return { error: 'not found' }

        const targetLocus = locus ?? old.locus

        const [corrected] = await db.insert(locigrams).values({
          content: correction,
          locus: targetLocus,
          sourceType: 'manual',
          palaceId,
          metadata: { corrects_id: oldId },
          tier: 'hot',
          confidence: 1.0,
          entities: [],
        }).returning()

        await db.update(locigrams)
          .set({
            expiresAt: sql`NOW()`,
            metadata: sql`${locigrams.metadata} || ${JSON.stringify({ superseded_by: corrected.id })}::jsonb`,
          })
          .where(and(eq(locigrams.id, oldId), eq(locigrams.palaceId, palaceId)))

        const vec = await vector.embed(correction)
        await vector.upsert(collection, corrected.id, vec, {
          palace_id: palaceId,
          locus: targetLocus,
          source_type: 'manual',
          connector: 'mcp',
          entities: [],
          confidence: 1.0,
          created_at: corrected.createdAt.toISOString(),
        })

        await db.update(locigrams)
          .set({ embeddingId: corrected.id, tier: 'hot' })
          .where(eq(locigrams.id, corrected.id))

        return { newId: corrected.id, supersededId: oldId, status: 'corrected' }
      },
    },

    // ── Connector instance management ──────────────────────────────────────────

    connectors_list: {
      description: 'List all connector instances configured for this palace.',
      schema: z.object({}),
      handler: async () => {
        const rows = await db.select().from(connectorInstances)
          .where(eq(connectorInstances.palaceId, palaceId))
          .orderBy(desc(connectorInstances.createdAt))
        return { connectors: rows, total: rows.length }
      },
    },

    connectors_create: {
      description: 'Create a new connector instance for this palace.',
      schema: z.object({
        connectorType: z.string().describe('Connector type e.g. gmail, obsidian, slack'),
        name:          z.string().describe('Display name for this connector instance'),
        config:        z.record(z.string(), z.unknown()).default({}).describe('Connector-specific configuration'),
        schedule:      z.string().optional().describe('Cron expression for automatic sync (null = manual only)'),
      }),
      handler: async ({ connectorType, name: instanceName, config: instanceConfig, schedule }: any) => {
        const [instance] = await db.insert(connectorInstances).values({
          palaceId,
          connectorType,
          name: instanceName,
          config: instanceConfig,
          schedule: schedule ?? null,
        }).returning()
        return instance
      },
    },

    connectors_sync: {
      description: 'Trigger a manual sync for a connector instance.',
      schema: z.object({
        id: z.string().uuid().describe('Connector instance ID'),
      }),
      handler: async ({ id: instanceId }: { id: string }) => {
        const [instance] = await db.select().from(connectorInstances)
          .where(and(eq(connectorInstances.id, instanceId), eq(connectorInstances.palaceId, palaceId)))
          .limit(1)

        if (!instance) return { error: 'not found' }
        if (instance.status === 'disabled') return { error: 'connector is disabled' }

        const [sync] = await db.insert(connectorSyncs).values({
          instanceId,
          cursorBefore: instance.cursor,
        }).returning()

        const startTime = Date.now()

        // TODO: Phase 2 — actually invoke the connector's pull() here
        const [completedSync] = await db.update(connectorSyncs)
          .set({ status: 'completed', completedAt: new Date(), durationMs: Date.now() - startTime })
          .where(eq(connectorSyncs.id, sync.id))
          .returning()

        await db.update(connectorInstances)
          .set({ lastSyncAt: new Date(), updatedAt: new Date() })
          .where(eq(connectorInstances.id, instanceId))

        return completedSync
      },
    },

    connectors_status: {
      description: 'Get status and recent sync history for a connector instance.',
      schema: z.object({
        id: z.string().uuid().describe('Connector instance ID'),
      }),
      handler: async ({ id: instanceId }: { id: string }) => {
        const [instance] = await db.select().from(connectorInstances)
          .where(and(eq(connectorInstances.id, instanceId), eq(connectorInstances.palaceId, palaceId)))
          .limit(1)

        if (!instance) return { error: 'not found' }

        const recentSyncs = await db.select().from(connectorSyncs)
          .where(eq(connectorSyncs.instanceId, instanceId))
          .orderBy(desc(connectorSyncs.startedAt))
          .limit(5)

        return { ...instance, recentSyncs }
      },
    },
  }
}
