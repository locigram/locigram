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

    palaceId:    palaceId(),
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
    index('locigrams_is_reference_idx').on(t.palaceId, t.isReference),
    index('locigrams_reference_type_idx').on(t.palaceId, t.referenceType),

    // Temporal
    index('locigrams_occurred_at_idx').on(t.palaceId, t.occurredAt),
    index('locigrams_created_at_idx').on(t.palaceId, t.createdAt),
    index('locigrams_expires_at_idx').on(t.expiresAt),

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

// ── Types ─────────────────────────────────────────────────────────────────────

export type Palace    = typeof palaces.$inferSelect
export type Locigram  = typeof locigrams.$inferSelect
export type Truth     = typeof truths.$inferSelect
export type Entity    = typeof entities.$inferSelect
export type Source    = typeof sources.$inferSelect

export type NewPalace   = typeof palaces.$inferInsert
export type NewLocigram = typeof locigrams.$inferInsert
export type NewTruth    = typeof truths.$inferInsert
export type NewEntity   = typeof entities.$inferInsert
export type NewSource   = typeof sources.$inferInsert

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
