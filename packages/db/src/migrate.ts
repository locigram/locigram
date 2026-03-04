import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const palaceId   = process.env.PALACE_ID   ?? 'default'
const palaceName = process.env.PALACE_NAME ?? 'Default User'

console.log('[migrate] running migrations...')

const sql = postgres(url, { max: 1 })

// Drop & recreate (early-stage, no prod data yet)
await sql`DROP TABLE IF EXISTS retrieval_events CASCADE`
await sql`DROP TABLE IF EXISTS sources   CASCADE`
await sql`DROP TABLE IF EXISTS entities  CASCADE`
await sql`DROP TABLE IF EXISTS truths    CASCADE`
await sql`DROP TABLE IF EXISTS locigrams CASCADE`
await sql`DROP TABLE IF EXISTS palaces   CASCADE`

await sql`
  CREATE TABLE palaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    api_token  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

await sql`
  CREATE TABLE locigrams (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    content        TEXT        NOT NULL,

    -- Source provenance
    source_type    TEXT        NOT NULL,   -- email|ticket|device|chat|conversation|manual|webhook
    source_ref     TEXT,                   -- unique ID in source system (dedup key)
    connector      TEXT,                   -- which connector produced this

    -- Temporal
    occurred_at    TIMESTAMPTZ,            -- when the event happened (from source)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ,            -- set when superseded or decayed

    -- Classification
    locus          TEXT        NOT NULL,   -- namespace: people/x, business/x, technical/x, project/x
    client_id      TEXT,                   -- MSP client (first-class filter)
    importance     TEXT        NOT NULL DEFAULT 'normal', -- low | normal | high

    -- Storage tier
    -- hot  = recent + high confidence + is_reference → active in Qdrant
    -- warm = older / lower confidence → active in Qdrant
    -- cold = archived / superseded / decayed → Postgres only, out of Qdrant
    tier           TEXT        NOT NULL DEFAULT 'hot',

    -- Knowledge vs reference data
    -- is_reference=true: stable facts about things (IPs, versions, contracts, contacts)
    --   → truth engine skips, never decays, only expires when explicitly superseded
    -- is_reference=false: events/relationships → truth engine applies, decays over time
    is_reference   BOOLEAN     NOT NULL DEFAULT FALSE,
    reference_type TEXT,       -- network_device|software|configuration|service_account|contract|contact

    -- Extraction outputs
    entities       TEXT[]      NOT NULL DEFAULT '{}',
    confidence     REAL        NOT NULL DEFAULT 1.0,
    metadata       JSONB       NOT NULL DEFAULT '{}',

    -- Vector
    embedding_id   TEXT,                   -- Qdrant point ID (null = not yet embedded)

    -- Access scoring (memory intelligence)
    access_count      INT         NOT NULL DEFAULT 0,
    last_accessed_at  TIMESTAMPTZ,
    access_score      FLOAT       NOT NULL DEFAULT 1.0,
    cluster_candidate BOOLEAN     NOT NULL DEFAULT FALSE,

    palace_id      TEXT        NOT NULL REFERENCES palaces(id) ON DELETE CASCADE
  )
`

await sql`
  CREATE TABLE truths (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    statement    TEXT        NOT NULL,
    locus        TEXT        NOT NULL,
    entities     TEXT[]      NOT NULL DEFAULT '{}',
    confidence   REAL        NOT NULL DEFAULT 0.0,
    source_count INTEGER     NOT NULL DEFAULT 1,
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locigram_ids UUID[]      NOT NULL DEFAULT '{}',
    palace_id    TEXT        NOT NULL REFERENCES palaces(id) ON DELETE CASCADE
  )
`

await sql`
  CREATE TABLE entities (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT        NOT NULL,
    type       TEXT        NOT NULL,   -- person|org|product|topic|place
    aliases    TEXT[]      NOT NULL DEFAULT '{}',
    metadata   JSONB       NOT NULL DEFAULT '{}',
    palace_id  TEXT        NOT NULL REFERENCES palaces(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (palace_id, name)
  )
`

await sql`
  CREATE TABLE sources (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    locigram_id UUID        NOT NULL REFERENCES locigrams(id) ON DELETE CASCADE,
    connector   TEXT        NOT NULL,
    raw_ref     TEXT,
    raw_url     TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    palace_id   TEXT        NOT NULL REFERENCES palaces(id) ON DELETE CASCADE
  )
`

await sql`
  CREATE TABLE retrieval_events (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    palace_id     TEXT        NOT NULL REFERENCES palaces(id) ON DELETE CASCADE,
    query_text    TEXT,
    locigram_ids  TEXT[]      NOT NULL DEFAULT '{}',
    retrieved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

await sql`
  CREATE TABLE IF NOT EXISTS sync_cursors (
    palace_id   TEXT NOT NULL,
    source      TEXT NOT NULL,
    cursor      TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (palace_id, source)
  )
`

await sql`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    secret_hash   TEXT NOT NULL,
    redirect_uris TEXT[] NOT NULL DEFAULT '{}',
    palace_id     TEXT NOT NULL REFERENCES palaces(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    revoked_at    TIMESTAMPTZ
  )
`

await sql`
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code            TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES oauth_clients(id),
    redirect_uri    TEXT NOT NULL,
    palace_id       TEXT NOT NULL,
    code_challenge  TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ
  )
`

// ── Indexes ───────────────────────────────────────────────────────────────────

// locigrams — btree
await sql`CREATE UNIQUE INDEX locigrams_source_ref_unique  ON locigrams(palace_id, source_ref) WHERE source_ref IS NOT NULL`
await sql`CREATE INDEX IF NOT EXISTS locigrams_palace_id_idx             ON locigrams(palace_id)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_locus_idx                 ON locigrams(palace_id, locus)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_source_type_idx           ON locigrams(palace_id, source_type)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_connector_idx             ON locigrams(palace_id, connector)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_client_id_idx             ON locigrams(palace_id, client_id) WHERE client_id IS NOT NULL`
await sql`CREATE INDEX IF NOT EXISTS locigrams_tier_idx                  ON locigrams(palace_id, tier)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_is_reference_idx          ON locigrams(palace_id, is_reference)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_reference_type_idx        ON locigrams(palace_id, reference_type) WHERE reference_type IS NOT NULL`
await sql`CREATE INDEX IF NOT EXISTS locigrams_occurred_at_idx           ON locigrams(palace_id, occurred_at) WHERE occurred_at IS NOT NULL`
await sql`CREATE INDEX IF NOT EXISTS locigrams_created_at_idx            ON locigrams(palace_id, created_at)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_expires_at_idx            ON locigrams(expires_at) WHERE expires_at IS NOT NULL`
await sql`CREATE INDEX IF NOT EXISTS locigrams_embedding_pending_idx     ON locigrams(palace_id) WHERE embedding_id IS NULL AND tier IN ('hot','warm')`

// locigrams — access scoring
await sql`CREATE INDEX IF NOT EXISTS locigrams_access_score_idx      ON locigrams(palace_id, access_score)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_last_accessed_idx     ON locigrams(palace_id, last_accessed_at) WHERE last_accessed_at IS NOT NULL`
await sql`CREATE INDEX IF NOT EXISTS locigrams_cluster_candidate_idx ON locigrams(palace_id, cluster_candidate) WHERE cluster_candidate = TRUE`

// locigrams — GIN
await sql`CREATE INDEX IF NOT EXISTS locigrams_entities_gin  ON locigrams USING GIN(entities)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_metadata_gin  ON locigrams USING GIN(metadata)`
await sql`CREATE INDEX IF NOT EXISTS locigrams_fts_idx       ON locigrams USING GIN(to_tsvector('english', content))`

// truths
await sql`CREATE INDEX IF NOT EXISTS truths_palace_id_idx   ON truths(palace_id)`
await sql`CREATE INDEX IF NOT EXISTS truths_locus_idx        ON truths(palace_id, locus)`
await sql`CREATE INDEX IF NOT EXISTS truths_confidence_idx   ON truths(palace_id, confidence)`
await sql`CREATE INDEX IF NOT EXISTS truths_last_seen_idx    ON truths(last_seen)`

// entities
await sql`CREATE INDEX IF NOT EXISTS entities_palace_id_idx ON entities(palace_id)`
await sql`CREATE INDEX IF NOT EXISTS entities_type_idx       ON entities(palace_id, type)`
await sql`CREATE INDEX IF NOT EXISTS entities_aliases_gin    ON entities USING GIN(aliases)`

// sources
await sql`CREATE INDEX IF NOT EXISTS sources_locigram_id_idx ON sources(locigram_id)`
await sql`CREATE INDEX IF NOT EXISTS sources_palace_id_idx   ON sources(palace_id)`
await sql`CREATE INDEX IF NOT EXISTS sources_connector_idx   ON sources(palace_id, connector)`

// retrieval_events
await sql`CREATE INDEX IF NOT EXISTS retrieval_events_palace_idx  ON retrieval_events(palace_id, retrieved_at)`
await sql`CREATE INDEX IF NOT EXISTS retrieval_events_ids_gin     ON retrieval_events USING GIN(locigram_ids)`

// oauth_clients
await sql`CREATE INDEX IF NOT EXISTS oauth_clients_palace_id_idx ON oauth_clients(palace_id)`
await sql`CREATE INDEX IF NOT EXISTS oauth_clients_revoked_idx   ON oauth_clients(palace_id) WHERE revoked_at IS NULL`

// oauth_codes
await sql`CREATE INDEX IF NOT EXISTS oauth_codes_client_id_idx ON oauth_codes(client_id)`
await sql`CREATE INDEX IF NOT EXISTS oauth_codes_expires_idx   ON oauth_codes(expires_at)`

// ── Seed palace ───────────────────────────────────────────────────────────────

await sql`
  INSERT INTO palaces (id, name, owner_id, api_token)
  VALUES (${palaceId}, ${palaceName}, 'system', ${process.env.API_TOKEN ?? ''})
  ON CONFLICT (id) DO UPDATE SET api_token = EXCLUDED.api_token
`

await sql.end()
console.log('[migrate] done')
process.exit(0)
