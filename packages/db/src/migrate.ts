import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

console.log('[migrate] running migrations...')

const sql = postgres(url, { max: 1 })

await sql`
  CREATE TABLE IF NOT EXISTS palaces (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    api_token  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

await sql`
  CREATE TABLE IF NOT EXISTS locigrams (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content      TEXT NOT NULL,
    source_type  TEXT NOT NULL,
    source_ref   TEXT,
    connector    TEXT,
    locus        TEXT NOT NULL,
    entities     TEXT[] NOT NULL DEFAULT '{}',
    confidence   REAL NOT NULL DEFAULT 1.0,
    metadata     JSONB NOT NULL DEFAULT '{}',
    embedding_id TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ,
    palace_id    UUID NOT NULL REFERENCES palaces(id) ON DELETE CASCADE
  )
`

await sql`
  CREATE TABLE IF NOT EXISTS truths (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement    TEXT NOT NULL,
    locus        TEXT NOT NULL,
    entities     TEXT[] NOT NULL DEFAULT '{}',
    confidence   REAL NOT NULL DEFAULT 0.0,
    source_count INTEGER NOT NULL DEFAULT 1,
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locigram_ids UUID[] NOT NULL DEFAULT '{}',
    palace_id    UUID NOT NULL REFERENCES palaces(id) ON DELETE CASCADE
  )
`

await sql`
  CREATE TABLE IF NOT EXISTS entities (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    aliases    TEXT[] NOT NULL DEFAULT '{}',
    metadata   JSONB NOT NULL DEFAULT '{}',
    palace_id  UUID NOT NULL REFERENCES palaces(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (palace_id, name)
  )
`

await sql`
  CREATE TABLE IF NOT EXISTS sources (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    locigram_id UUID NOT NULL REFERENCES locigrams(id) ON DELETE CASCADE,
    connector   TEXT NOT NULL,
    raw_ref     TEXT,
    raw_url     TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    palace_id   UUID NOT NULL REFERENCES palaces(id) ON DELETE CASCADE
  )
`

// Indexes
await sql`CREATE INDEX IF NOT EXISTS locigrams_palace_id_idx    ON locigrams(palace_id)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_locus_idx        ON locigrams(palace_id, locus)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_source_type_idx  ON locigrams(palace_id, source_type)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_connector_idx    ON locigrams(palace_id, connector)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_created_at_idx   ON locigrams(palace_id, created_at)`
await sql`CREATE INDEX IF NOT EXISTS truths_palace_id_idx       ON truths(palace_id)`
await sql`CREATE INDEX IF NOT EXISTS truths_locus_idx           ON truths(palace_id, locus)`
await sql`CREATE INDEX IF NOT EXISTS entities_palace_id_idx     ON entities(palace_id)`
await sql`CREATE INDEX IF NOT EXISTS sources_locigram_id_idx    ON sources(locigram_id)`
await sql`CREATE INDEX IF NOT EXISTS sources_connector_idx      ON sources(palace_id, connector)`

// GIN indexes for array search
await sql`CREATE INDEX IF NOT EXISTS locigrams_entities_gin ON locigrams USING GIN(entities)`
await sql`CREATE INDEX IF NOT EXISTS entities_aliases_gin   ON entities  USING GIN(aliases)`

await sql.end()
console.log('[migrate] done')
process.exit(0)
