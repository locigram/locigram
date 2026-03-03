import {
  pgTable,
  uuid,
  text,
  float4,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ── Helpers ───────────────────────────────────────────────────────────────────

const id = () => uuid('id').primaryKey().defaultRandom()
const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const palaceId = () =>
  uuid('palace_id')
    .notNull()
    .references(() => palaces.id, { onDelete: 'cascade' })

// ── palaces ───────────────────────────────────────────────────────────────────

export const palaces = pgTable('palaces', {
  id:        id(),
  name:      text('name').notNull(),
  ownerId:   text('owner_id').notNull(),
  apiToken:  text('api_token'),             // hashed bearer token
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── locigrams ─────────────────────────────────────────────────────────────────

export const locigrams = pgTable(
  'locigrams',
  {
    id:          id(),
    content:     text('content').notNull(),
    sourceType:  text('source_type').notNull(),   // email|chat|sms|system|manual|webhook
    sourceRef:   text('source_ref'),              // unique ID in source system
    connector:   text('connector'),               // which plugin produced this (microsoft365, halopsa, etc.)
    locus:       text('locus').notNull(),
    entities:    text('entities').array().notNull().default(sql`'{}'`),
    confidence:  float4('confidence').notNull().default(1.0),
    metadata:    jsonb('metadata').notNull().default(sql`'{}'`),
    embeddingId: text('embedding_id'),            // Qdrant point ID
    createdAt:   now(),
    expiresAt:   timestamp('expires_at', { withTimezone: true }),
    palaceId:    palaceId(),
  },
  (t) => [
    index('locigrams_palace_id_idx').on(t.palaceId),
    index('locigrams_locus_idx').on(t.palaceId, t.locus),
    index('locigrams_source_type_idx').on(t.palaceId, t.sourceType),
    index('locigrams_connector_idx').on(t.palaceId, t.connector),
    index('locigrams_created_at_idx').on(t.palaceId, t.createdAt),
    index('locigrams_expires_at_idx').on(t.expiresAt).where(sql`expires_at IS NOT NULL`),
    // GIN indexes declared in migration SQL (Drizzle doesn't support GIN natively yet)
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
    confidence:  float4('confidence').notNull().default(0.0),
    sourceCount: integer('source_count').notNull().default(1),
    lastSeen:    timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
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
    type:      text('type').notNull(),      // person|org|product|topic|place
    aliases:   text('aliases').array().notNull().default(sql`'{}'`),
    metadata:  jsonb('metadata').notNull().default(sql`'{}'`),
    palaceId:  palaceId(),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('entities_palace_name_unique').on(t.palaceId, t.name),
    index('entities_palace_id_idx').on(t.palaceId),
    index('entities_type_idx').on(t.palaceId, t.type),
  ],
)

// ── sources ───────────────────────────────────────────────────────────────────

export const sources = pgTable(
  'sources',
  {
    id:          id(),
    locigramId:  uuid('locigram_id')
                   .notNull()
                   .references(() => locigrams.id, { onDelete: 'cascade' }),
    connector:   text('connector').notNull(),   // e.g. 'locigram-connector-email'
    rawRef:      text('raw_ref'),               // ID in source system
    rawUrl:      text('raw_url'),               // link back to original
    ingestedAt:  timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
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
