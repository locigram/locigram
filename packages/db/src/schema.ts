import {
  pgTable,
  uuid,
  text,
  real,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ── Helpers ───────────────────────────────────────────────────────────────────

const id      = () => uuid('id').primaryKey().defaultRandom()
const now     = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const tstz    = (col: string) => timestamp(col, { withTimezone: true })
const palaceId = () =>
  text('palace_id').notNull().references(() => palaces.id, { onDelete: 'cascade' })

// ── palaces ───────────────────────────────────────────────────────────────────

export const palaces = pgTable('palaces', {
  id:        text('id').primaryKey(),
  name:      text('name').notNull(),
  ownerId:   text('owner_id').notNull(),
  apiToken:  text('api_token'),
  createdAt: now(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
})

// ── locigrams ─────────────────────────────────────────────────────────────────

export const locigrams = pgTable(
  'locigrams',
  {
    id:          id(),
    content:     text('content').notNull(),

    // Source provenance
    sourceType:  text('source_type').notNull(),   // email|ticket|device|chat|conversation|manual|webhook
    sourceRef:   text('source_ref'),              // dedup key — UNIQUE(palace_id, source_ref) in DB
    connector:   text('connector'),               // which connector produced this

    // Temporal
    occurredAt:  tstz('occurred_at'),             // when the event happened (from source)
    createdAt:   now(),
    expiresAt:   tstz('expires_at'),              // null = active; set when superseded or decayed

    // Classification
    locus:       text('locus').notNull(),         // namespace: people/x, business/x, technical/x, project/x
    clientId:    text('client_id'),               // MSP client (first-class filter)
    importance:  text('importance').notNull().default('normal'), // low | normal | high
    category:    text('category').notNull().default('observation'), // decision | preference | fact | lesson | entity | observation | convention | checkpoint

    // Storage tier
    // hot  = recent + high confidence + is_reference → active in Qdrant
    // warm = older / lower confidence → still in Qdrant
    // cold = archived / superseded / decayed → Postgres only, removed from Qdrant
    tier:        text('tier').notNull().default('hot'),

    // Knowledge vs reference
    // is_reference=false: events/relationships → truth engine applies, decays over time
    // is_reference=true:  stable facts about things → truth engine skips, never decays,
    //                     only expires when explicitly superseded by newer data
    isReference:   boolean('is_reference').notNull().default(false),
    referenceType: text('reference_type'), // network_device|software|configuration|service_account|contract|contact

    // Extraction outputs
    entities:    text('entities').array().notNull().default(sql`'{}'`),
    confidence:  real('confidence').notNull().default(1.0),
    metadata:    jsonb('metadata').notNull().default(sql`'{}'`),

    // Vector
    embeddingId: text('embedding_id'),            // Qdrant point ID; null = pending embed

    // Graph sync
    graphSyncedAt: timestamp('graph_synced_at', { withTimezone: true }),  // null = pending graph write

    // Access scoring (memory intelligence)
    accessCount:      integer('access_count').notNull().default(0),
    lastAccessedAt:   timestamp('last_accessed_at', { withTimezone: true }),
    accessScore:      real('access_score').notNull().default(1.0),
    clusterCandidate: boolean('cluster_candidate').notNull().default(false),

    // Structured recall (SPO triple)
    subject:     text('subject'),                  // entity this fact is about
    predicate:   text('predicate'),                // attribute/relationship
    objectVal:   text('object_val'),               // the value

    // Durability
    durabilityClass: text('durability_class').notNull().default('active'), // permanent | stable | active | session | checkpoint
    supersededBy:    uuid('superseded_by'),         // UUID of the locigram that replaced this one (no FK)

    palaceId:    palaceId(),
    connectorInstanceId: uuid('connector_instance_id').references(() => connectorInstances.id, { onDelete: 'set null' }),
  },
  (t) => [
    // Dedup — enforced at DB level
    uniqueIndex('locigrams_source_ref_unique').on(t.palaceId, t.sourceRef).where(sql`source_ref IS NOT NULL`),

    // Core filters
    index('locigrams_palace_id_idx').on(t.palaceId),
    index('locigrams_locus_idx').on(t.palaceId, t.locus),
    index('locigrams_source_type_idx').on(t.palaceId, t.sourceType),
    index('locigrams_connector_idx').on(t.palaceId, t.connector),
    index('locigrams_client_id_idx').on(t.palaceId, t.clientId),
    index('locigrams_tier_idx').on(t.palaceId, t.tier),
    index('locigrams_category_idx').on(t.palaceId, t.category),
    index('locigrams_graph_synced_idx').on(t.palaceId, t.graphSyncedAt),
    index('locigrams_is_reference_idx').on(t.palaceId, t.isReference),
    index('locigrams_reference_type_idx').on(t.palaceId, t.referenceType),

    // Temporal
    index('locigrams_occurred_at_idx').on(t.palaceId, t.occurredAt),
    index('locigrams_created_at_idx').on(t.palaceId, t.createdAt),
    index('locigrams_expires_at_idx').on(t.expiresAt),

    // Structured recall indexes
    index('locigrams_subject_idx').on(t.palaceId, t.subject),
    index('locigrams_predicate_idx').on(t.palaceId, t.predicate),
    index('locigrams_durability_class_idx').on(t.palaceId, t.durabilityClass),
    index('locigrams_superseded_by_idx').on(t.supersededBy),

    // Pending embed (partial index declared in migrate.ts)
    // GIN indexes declared in migrate.ts (Drizzle doesn't support GIN natively)
  ],
)

// ── truths ────────────────────────────────────────────────────────────────────

export const truths = pgTable(
  'truths',
  {
    id:          id(),
    statement:   text('statement').notNull(),
    locus:       text('locus').notNull(),
    entities:    text('entities').array().notNull().default(sql`'{}'`),
    confidence:  real('confidence').notNull().default(0.0),
    sourceCount: integer('source_count').notNull().default(1),
    lastSeen:    tstz('last_seen').notNull().defaultNow(),
    createdAt:   now(),
    locigramIds: uuid('locigram_ids').array().notNull().default(sql`'{}'`),
    palaceId:    palaceId(),
  },
  (t) => [
    index('truths_palace_id_idx').on(t.palaceId),
    index('truths_locus_idx').on(t.palaceId, t.locus),
    index('truths_confidence_idx').on(t.palaceId, t.confidence),
    index('truths_last_seen_idx').on(t.lastSeen),
  ],
)

// ── entities ──────────────────────────────────────────────────────────────────

export const entities = pgTable(
  'entities',
  {
    id:        id(),
    name:      text('name').notNull(),
    type:      text('type').notNull(),     // person|org|product|topic|place
    aliases:   text('aliases').array().notNull().default(sql`'{}'`),
    metadata:  jsonb('metadata').notNull().default(sql`'{}'`),
    palaceId:  palaceId(),
    createdAt: now(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('entities_palace_name_unique').on(t.palaceId, t.name),
    index('entities_palace_id_idx').on(t.palaceId),
    index('entities_type_idx').on(t.palaceId, t.type),
    // GIN index on aliases declared in migrate.ts
  ],
)

// ── entity_mentions ───────────────────────────────────────────────────────────

export const entityMentions = pgTable(
  'entity_mentions',
  {
    id:         id(),
    locigramId: uuid('locigram_id').notNull().references(() => locigrams.id, { onDelete: 'cascade' }),
    entityId:   uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    rawText:    text('raw_text').notNull(),
    type:       text('type').notNull(),
    confidence: real('confidence').notNull(),
    source:     text('source').notNull().default('gliner'),  // gliner | llm | manual
    spanStart:  integer('span_start'),
    spanEnd:    integer('span_end'),
    palaceId:   palaceId(),
    createdAt:  now(),
  },
  (t) => [
    index('entity_mentions_locigram_idx').on(t.locigramId),
    index('entity_mentions_entity_idx').on(t.entityId),
    index('entity_mentions_palace_type_idx').on(t.palaceId, t.type),
    index('entity_mentions_palace_source_idx').on(t.palaceId, t.source),
  ],
)

// ── sources ───────────────────────────────────────────────────────────────────

export const sources = pgTable(
  'sources',
  {
    id:          id(),
    locigramId:  uuid('locigram_id').notNull().references(() => locigrams.id, { onDelete: 'cascade' }),
    connector:   text('connector').notNull(),
    rawRef:      text('raw_ref'),
    rawUrl:      text('raw_url'),
    ingestedAt:  tstz('ingested_at').notNull().defaultNow(),
    palaceId:    palaceId(),
  },
  (t) => [
    index('sources_locigram_id_idx').on(t.locigramId),
    index('sources_palace_id_idx').on(t.palaceId),
    index('sources_connector_idx').on(t.palaceId, t.connector),
  ],
)

// ── retrieval_events ─────────────────────────────────────────────────────

export const retrievalEvents = pgTable('retrieval_events', {
  id:          uuid('id').primaryKey().defaultRandom(),
  palaceId:    text('palace_id').notNull().references(() => palaces.id, { onDelete: 'cascade' }),
  queryText:   text('query_text'),
  locigramIds: text('locigram_ids').array().notNull().default([]),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── sync_cursors ─────────────────────────────────────────────────────────────

export const syncCursors = pgTable(
  'sync_cursors',
  {
    palaceId:  text('palace_id').notNull(),
    source:    text('source').notNull(),       // e.g. 'm365-email', 'm365-teams', 'halopsa'
    cursor:    text('cursor').notNull(),        // ISO timestamp or opaque string
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sync_cursors_pk').on(t.palaceId, t.source),
  ],
)

// ── oauth_clients ────────────────────────────────────────────────────────────

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id:           text('id').primaryKey(),
    name:         text('name').notNull(),
    secretHash:   text('secret_hash').notNull(),
    redirectUris: text('redirect_uris').array().notNull().default(sql`'{}'`),
    palaceId:     palaceId(),
    service:      text('service'),   // 'claude'|'chatgpt'|'gemini'|'perplexity'|'copilot'|'grok'|'mistral'|'llama'|'other' — null for non-LLM clients
    createdAt:    tstz('created_at').defaultNow(),
    revokedAt:    tstz('revoked_at'),
  },
  (t) => [
    index('oauth_clients_palace_id_idx').on(t.palaceId),
  ],
)

// ── oauth_codes ──────────────────────────────────────────────────────────────

export const oauthCodes = pgTable(
  'oauth_codes',
  {
    code:          text('code').primaryKey(),
    clientId:      text('client_id').notNull().references(() => oauthClients.id),
    redirectUri:   text('redirect_uri').notNull(),
    palaceId:      text('palace_id').notNull(),
    codeChallenge: text('code_challenge'),
    expiresAt:     tstz('expires_at').notNull(),
    usedAt:        tstz('used_at'),
  },
  (t) => [
    index('oauth_codes_client_id_idx').on(t.clientId),
    index('oauth_codes_expires_idx').on(t.expiresAt),
  ],
)

// ── oauth_access_tokens ──────────────────────────────────────────────────────

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id:          text('id').primaryKey(),          // random UUID
    tokenHash:   text('token_hash').notNull(),     // sha256 hex of the raw token
    clientId:    text('client_id').notNull().references(() => oauthClients.id),
    palaceId:    text('palace_id').notNull(),
    createdAt:   tstz('created_at').defaultNow(),
    expiresAt:   tstz('expires_at').notNull(),     // 1 year from issue
    revokedAt:   tstz('revoked_at'),
    lastUsedAt:  tstz('last_used_at'),
  },
  (t) => [
    uniqueIndex('oauth_access_tokens_hash_idx').on(t.tokenHash),
    index('oauth_access_tokens_client_idx').on(t.clientId),
    index('oauth_access_tokens_palace_idx').on(t.palaceId),
  ],
)

// ── connector_instances ──────────────────────────────────────────────────────

export const connectorInstances = pgTable(
  'connector_instances',
  {
    id:             id(),
    palaceId:       text('palace_id').notNull().references(() => palaces.id, { onDelete: 'cascade' }),
    connectorType:  text('connector_type').notNull(),
    name:           text('name').notNull(),
    distribution:   text('distribution').notNull().default('external'), // 'bundled' | 'external'
    config:         jsonb('config').notNull().default(sql`'{}'`),
    schedule:       text('schedule'),
    cursor:         jsonb('cursor'),
    status:         text('status').notNull().default('active'),
    tokenHash:      text('token_hash'),
    lastSyncAt:     tstz('last_sync_at'),
    lastError:      text('last_error'),
    itemsSynced:    integer('items_synced').notNull().default(0),
    createdAt:      now(),
    updatedAt:      tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('connector_instances_palace_idx').on(t.palaceId),
    index('connector_instances_type_idx').on(t.palaceId, t.connectorType),
  ],
)

// ── connector_syncs ─────────────────────────────────────────────────────────

export const connectorSyncs = pgTable(
  'connector_syncs',
  {
    id:           id(),
    instanceId:   uuid('instance_id').notNull().references(() => connectorInstances.id, { onDelete: 'cascade' }),
    startedAt:    tstz('started_at').notNull().defaultNow(),
    completedAt:  tstz('completed_at'),
    itemsPulled:  integer('items_pulled').notNull().default(0),
    itemsPushed:  integer('items_pushed').notNull().default(0),
    itemsSkipped: integer('items_skipped').notNull().default(0),
    status:       text('status').notNull().default('running'),
    error:        text('error'),
    cursorBefore: jsonb('cursor_before'),
    cursorAfter:  jsonb('cursor_after'),
    durationMs:   integer('duration_ms'),
  },
  (t) => [
    index('connector_syncs_instance_idx').on(t.instanceId, t.startedAt),
  ],
)

// ── Types ─────────────────────────────────────────────────────────────────────

export type Palace    = typeof palaces.$inferSelect
export type Locigram  = typeof locigrams.$inferSelect
export type Truth     = typeof truths.$inferSelect
export type Entity    = typeof entities.$inferSelect
export type EntityMention   = typeof entityMentions.$inferSelect
export type Source          = typeof sources.$inferSelect
export type RetrievalEvent = typeof retrievalEvents.$inferSelect
export type SyncCursor     = typeof syncCursors.$inferSelect
export type OAuthClient    = typeof oauthClients.$inferSelect
export type OAuthCode      = typeof oauthCodes.$inferSelect

export type NewPalace          = typeof palaces.$inferInsert
export type NewLocigram        = typeof locigrams.$inferInsert
export type NewTruth           = typeof truths.$inferInsert
export type NewEntity          = typeof entities.$inferInsert
export type NewEntityMention   = typeof entityMentions.$inferInsert
export type NewSource          = typeof sources.$inferInsert
export type NewRetrievalEvent  = typeof retrievalEvents.$inferInsert
export type NewSyncCursor      = typeof syncCursors.$inferInsert
export type NewOAuthClient     = typeof oauthClients.$inferInsert
export type NewOAuthCode       = typeof oauthCodes.$inferInsert
export type OAuthAccessToken   = typeof oauthAccessTokens.$inferSelect
export type NewOAuthAccessToken = typeof oauthAccessTokens.$inferInsert
export type ConnectorInstance    = typeof connectorInstances.$inferSelect
export type NewConnectorInstance = typeof connectorInstances.$inferInsert
export type ConnectorSync        = typeof connectorSyncs.$inferSelect
export type NewConnectorSync     = typeof connectorSyncs.$inferInsert

// ── Reference type constants ──────────────────────────────────────────────────

export const REFERENCE_TYPES = [
  'network_device',    // IP, hostname, MAC, model, location
  'software',          // version, license, install state
  'configuration',     // settings, policies, baselines
  'service_account',   // usernames, roles, permissions (NOT passwords)
  'contract',          // SLA terms, renewal dates, pricing
  'contact',           // person details, phone, email, role
] as const

export type ReferenceType = typeof REFERENCE_TYPES[number]

// ── Tier constants ────────────────────────────────────────────────────────────

export const TIERS = ['hot', 'warm', 'cold'] as const
export type Tier = typeof TIERS[number]

// ── Durability class constants ───────────────────────────────────────────────

export const DURABILITY_CLASSES = ['permanent', 'stable', 'active', 'session', 'checkpoint'] as const
export type DurabilityClass = typeof DURABILITY_CLASSES[number]

export const CATEGORIES = [
  'decision',
  'preference',
  'fact',
  'lesson',
  'entity',
  'observation',
  'convention',
  'checkpoint',
] as const
export type Category = typeof CATEGORIES[number]
