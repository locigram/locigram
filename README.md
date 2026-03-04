# Locigram

> Self-hosted AI memory platform. Your memories never leave your infrastructure.

Locigram is an open-source memory layer for AI assistants — addressable via MCP and REST, deployable anywhere, owned entirely by you.

## Concepts

| Term | Meaning |
|------|---------|
| **Locigram** | A single memory unit — one fact, event, or observation |
| **Truth** | A reinforced fact built from multiple locigrams with confidence scoring and decay |
| **Palace** | One user or org's complete memory store |
| **Locus** | A namespace — `people/alice`, `business/acme`, `project/locigram`, etc. |
| **Connector** | A plugin that pulls from a data source (M365, HaloPSA, Gmail, etc.) |

---

## Quick Start (Docker)

**1. Copy the example env file**
```bash
cp .env.example .env
```

**2. Edit `.env`** — at minimum, set these:
```env
PALACE_ID=yourname
API_TOKEN=a-long-random-secret
POSTGRES_PASSWORD=another-random-secret
```

**3. Set your LLM** — Locigram uses three named roles, each independently configurable:

| Role | What it does | Requirement |
|------|-------------|-------------|
| **Embed** | Converts text to vectors for semantic search | `POST /v1/embeddings` |
| **Extract** | Parses entities, locus, and memory units from raw content | `POST /v1/chat/completions` + reliable JSON output |
| **Summary** | Promotes truths, summarizes across sources | `POST /v1/chat/completions` — falls back to Extract if not set |

Each role points at any **OpenAI-compatible endpoint**. Leave `*_KEY` blank for local/unauthenticated.

---

### 🟢 Ollama (local, free — recommended for getting started)

```bash
ollama pull nomic-embed-text   # embed
ollama pull qwen2.5:7b         # extract + summary
```
```env
# Embed
LOCIGRAM_EMBED_URL=http://localhost:11434/v1
LOCIGRAM_EMBED_MODEL=nomic-embed-text

# Extract
LOCIGRAM_EXTRACT_URL=http://localhost:11434/v1
LOCIGRAM_EXTRACT_MODEL=qwen2.5:7b

# Summary — use a larger model if you have the VRAM, otherwise leave blank to reuse extract
# LOCIGRAM_SUMMARY_URL=http://localhost:11434/v1
# LOCIGRAM_SUMMARY_MODEL=qwen2.5:14b
```

> **Recommended Ollama models by role:**
> - Embed: `nomic-embed-text` (best all-around), `mxbai-embed-large` (higher quality)
> - Extract: `qwen2.5:7b` (best JSON adherence at small size), `llama3.1:8b` (good alternative)
> - Summary: `qwen2.5:14b` or `llama3.1:70b` if you have the VRAM; otherwise reuse extract

---

### 🔵 OpenAI

```env
# Embed
LOCIGRAM_EMBED_URL=https://api.openai.com/v1
LOCIGRAM_EMBED_MODEL=text-embedding-3-small
LOCIGRAM_EMBED_KEY=sk-...

# Extract — gpt-4o-mini is the sweet spot: cheap, fast, excellent JSON
LOCIGRAM_EXTRACT_URL=https://api.openai.com/v1
LOCIGRAM_EXTRACT_MODEL=gpt-4o-mini
LOCIGRAM_EXTRACT_KEY=sk-...

# Summary — step up to gpt-4o for better truth synthesis (optional)
LOCIGRAM_SUMMARY_URL=https://api.openai.com/v1
LOCIGRAM_SUMMARY_MODEL=gpt-4o
LOCIGRAM_SUMMARY_KEY=sk-...
```

> **Recommended OpenAI models by role:**
> - Embed: `text-embedding-3-small` (cheap, great), `text-embedding-3-large` (best quality)
> - Extract: `gpt-4o-mini` — best cost/performance for structured JSON extraction
> - Summary: `gpt-4o` for production; `gpt-4o-mini` if you want to save cost

---

### 🟣 Groq (fast inference, free tier available)

```env
# Embed — Groq doesn't offer embeddings; use OpenAI or Ollama for this role
LOCIGRAM_EMBED_URL=https://api.openai.com/v1
LOCIGRAM_EMBED_MODEL=text-embedding-3-small
LOCIGRAM_EMBED_KEY=sk-...

# Extract + Summary — Groq is excellent for fast chat completions
LOCIGRAM_EXTRACT_URL=https://api.groq.com/openai/v1
LOCIGRAM_EXTRACT_MODEL=llama-3.1-8b-instant
LOCIGRAM_EXTRACT_KEY=gsk_...

LOCIGRAM_SUMMARY_URL=https://api.groq.com/openai/v1
LOCIGRAM_SUMMARY_MODEL=llama-3.3-70b-versatile
LOCIGRAM_SUMMARY_KEY=gsk_...
```

> **Note:** Groq doesn't provide an embeddings endpoint — mix with OpenAI or Ollama for the embed role.

---

### ⚙️ Any OpenAI-compatible API (Together, vLLM, LM Studio, etc.)

```env
LOCIGRAM_EMBED_URL=http://your-server:8000/v1
LOCIGRAM_EMBED_MODEL=your-embedding-model

LOCIGRAM_EXTRACT_URL=http://your-server:8000/v1
LOCIGRAM_EXTRACT_MODEL=your-chat-model
LOCIGRAM_EXTRACT_KEY=your-api-key-if-needed

# Summary can be a different server/model entirely
LOCIGRAM_SUMMARY_URL=http://your-bigger-server:8001/v1
LOCIGRAM_SUMMARY_MODEL=your-larger-model
```

**4. Start**
```bash
docker compose -f deploy/docker/docker-compose.yml up
```

API: `http://localhost:3000`  
MCP: `http://localhost:3000/mcp`

---

## Connectors

Connectors pull from external sources and feed locigrams into your palace.  
**They auto-register at startup** — just set the env vars for the ones you have. Leave the rest blank or absent.

### Microsoft 365 (email + Teams)
```env
LOCIGRAM_M365_TENANT_ID=your-tenant-id
LOCIGRAM_M365_CLIENT_ID=your-client-id
LOCIGRAM_M365_CLIENT_SECRET=your-client-secret
LOCIGRAM_M365_MAILBOXES=you@company.com,support@company.com
```

### HaloPSA (support tickets)
```env
LOCIGRAM_HALOPSA_URL=https://yourinstance.halopsa.com
LOCIGRAM_HALOPSA_CLIENT_ID=your-client-id
LOCIGRAM_HALOPSA_CLIENT_SECRET=your-client-secret
```

### NinjaOne (devices + alerts)
```env
LOCIGRAM_NINJA_CLIENT_ID=your-client-id
LOCIGRAM_NINJA_CLIENT_SECRET=your-client-secret
```

### Gmail
```env
LOCIGRAM_GMAIL_CLIENT_ID=your-client-id
LOCIGRAM_GMAIL_CLIENT_SECRET=your-client-secret
LOCIGRAM_GMAIL_REFRESH_TOKEN=your-refresh-token
```

### Webhook (always enabled)
Push any content directly:
```bash
curl -X POST http://localhost:3000/api/webhook/push \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Alice from Acme called about the renewal", "sourceType": "manual"}'
```

---

## Full Environment Variable Reference

### Required
| Variable | Description |
|----------|-------------|
| `PALACE_ID` | Unique slug for your palace (e.g. `yourname`) |
| `API_TOKEN` | Bearer token for API authentication |
| `POSTGRES_PASSWORD` | Postgres password |

### LLM — Embedding
| Variable | Default | Description |
|----------|---------|-------------|
| `LOCIGRAM_EMBED_URL` | `http://localhost:11434/v1` | OpenAI-compatible embeddings endpoint |
| `LOCIGRAM_EMBED_MODEL` | `nomic-embed-text` | Embedding model name |
| `LOCIGRAM_EMBED_KEY` | _(blank)_ | API key — omit for local endpoints |

### LLM — Extraction
| Variable | Default | Description |
|----------|---------|-------------|
| `LOCIGRAM_EXTRACT_URL` | `http://localhost:11434/v1` | OpenAI-compatible chat endpoint |
| `LOCIGRAM_EXTRACT_MODEL` | `qwen2.5:7b` | Chat model for entity + locus extraction |
| `LOCIGRAM_EXTRACT_KEY` | _(blank)_ | API key — omit for local endpoints |

### LLM — Summarization (optional)
| Variable | Default | Description |
|----------|---------|-------------|
| `LOCIGRAM_SUMMARY_URL` | _(falls back to extract)_ | Chat endpoint for truth promotion |
| `LOCIGRAM_SUMMARY_MODEL` | _(falls back to extract)_ | Model for summarization |
| `LOCIGRAM_SUMMARY_KEY` | _(blank)_ | API key |

### Connectors (all optional — activate by setting values)
| Variable | Connector | Description |
|----------|-----------|-------------|
| `LOCIGRAM_M365_TENANT_ID` | Microsoft 365 | Entra tenant ID |
| `LOCIGRAM_M365_CLIENT_ID` | Microsoft 365 | App registration client ID |
| `LOCIGRAM_M365_CLIENT_SECRET` | Microsoft 365 | App registration client secret |
| `LOCIGRAM_M365_MAILBOXES` | Microsoft 365 | Comma-separated mailboxes to ingest |
| `LOCIGRAM_HALOPSA_URL` | HaloPSA | Base URL of your HaloPSA instance |
| `LOCIGRAM_HALOPSA_CLIENT_ID` | HaloPSA | OAuth client ID |
| `LOCIGRAM_HALOPSA_CLIENT_SECRET` | HaloPSA | OAuth client secret |
| `LOCIGRAM_NINJA_CLIENT_ID` | NinjaOne | OAuth client ID |
| `LOCIGRAM_NINJA_CLIENT_SECRET` | NinjaOne | OAuth client secret |
| `LOCIGRAM_GMAIL_CLIENT_ID` | Gmail | OAuth2 client ID |
| `LOCIGRAM_GMAIL_CLIENT_SECRET` | Gmail | OAuth2 client secret |
| `LOCIGRAM_GMAIL_REFRESH_TOKEN` | Gmail | OAuth2 refresh token |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Locigram                   │
│                                             │
│  REST API + MCP  ←→  Pipeline  ←→  Qdrant  │
│        ↕                 ↕                  │
│     Postgres       LLM (embed/extract)      │
│        ↑                                    │
│   Connectors (M365, HaloPSA, Gmail, ...)    │
└─────────────────────────────────────────────┘
```

- **Postgres** — structured storage (locigrams, truths, entities, sources)
- **Qdrant** — vector search for semantic recall
- **Pipeline** — ingests raw content, calls LLM to extract entities + memory units
- **Truth engine** — promotes repeated facts into truths with confidence scores
- **Connectors** — pull from external sources; auto-activated by env vars

---

## Database Schema

Locigram uses 5 tables. All data — regardless of source — goes through the same `locigrams` table, enabling unified recall across emails, tickets, devices, conversations, and manual entries in a single query.

### palaces

One row per user or organization. A palace is a complete, isolated memory store.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `TEXT PK` | Slug identifier (e.g. `yourname`) — human-readable, used in K8s namespace naming |
| `name` | `TEXT` | Display name (e.g. `"Alice Smith"`) |
| `owner_id` | `TEXT` | Owner reference (set to `"system"` for self-hosted) |
| `api_token` | `TEXT` | Hashed bearer token for API auth |
| `created_at` | `TIMESTAMPTZ` | — |
| `updated_at` | `TIMESTAMPTZ` | — |

---

### locigrams ← the core table

Every memory unit ever stored. One table, all sources. Columns handle the segmentation.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | `UUID PK` | `gen_random_uuid()` | — |
| `content` | `TEXT` | — | The extracted memory unit in plain language |
| **Source provenance** | | | |
| `source_type` | `TEXT` | — | What kind of thing this came from: `email`, `ticket`, `device`, `chat`, `conversation`, `manual`, `webhook` |
| `source_ref` | `TEXT` | `NULL` | Unique ID in the source system — used for dedup. `UNIQUE(palace_id, source_ref)` enforced at DB level. |
| `connector` | `TEXT` | `NULL` | Which connector produced this: `microsoft365`, `halopsa`, `ninjaone`, `webhook`, `llm-session`, etc. |
| **Temporal** | | | |
| `occurred_at` | `TIMESTAMPTZ` | `NULL` | When the underlying event happened (e.g. email received date). Distinct from `created_at` (ingest time). Index allows temporal queries: "what did we know about X in Q4?" |
| `created_at` | `TIMESTAMPTZ` | `NOW()` | When this locigram was ingested |
| `expires_at` | `TIMESTAMPTZ` | `NULL` | `NULL` = active. Set when superseded (reference data) or decayed below threshold (knowledge). Record is kept for audit — never deleted. |
| **Classification** | | | |
| `locus` | `TEXT` | — | Memory namespace. Format: `people/name`, `business/orgname`, `technical/topic`, `personal/topic`, `project/name`, `agent/name`. Used for scoped recall. |
| `client_id` | `TEXT` | `NULL` | First-class MSP client filter. Allows "show me everything about Acme Corp" across all connectors. |
| `importance` | `TEXT` | `normal` | `low` / `normal` / `high`. Inherited from source metadata (email importance, ticket priority). |
| **Storage tier** | | | |
| `tier` | `TEXT` | `hot` | Controls Qdrant inclusion. `hot` = recent + high-confidence + reference → active in Qdrant. `warm` = older / lower-confidence → still in Qdrant. `cold` = archived / superseded / decayed → Postgres only, removed from Qdrant index. Keeps vector memory lean as data grows. |
| **Knowledge vs Reference** | | | |
| `is_reference` | `BOOLEAN` | `false` | `false` = knowledge (events, observations, relationships) — truth engine applies, decays over time. `true` = reference data (stable facts about things) — truth engine skips, never decays, only expires when explicitly superseded. |
| `reference_type` | `TEXT` | `NULL` | Only set when `is_reference = true`. See reference types below. |
| **Extraction outputs** | | | |
| `entities` | `TEXT[]` | `{}` | Resolved entity names from the palace entity registry. GIN-indexed for fast array containment queries. |
| `confidence` | `REAL` | `1.0` | Extraction confidence score (`0.0–1.0`). Locigrams below `MIN_CONFIDENCE` (0.3) are dropped before storage. |
| `metadata` | `JSONB` | `{}` | Connector-specific fields that don't warrant their own column. Email: `{sender, subject, mailbox}`. Ticket: `{priority, sla_state, category}`. GIN-indexed for key-based queries. |
| **Vector** | | | |
| `embedding_id` | `TEXT` | `NULL` | Qdrant point ID. `NULL` = pending embed. Background worker picks up `embedding_id IS NULL AND tier IN ('hot','warm')` every 30s. |
| `palace_id` | `TEXT FK` | — | References `palaces(id) ON DELETE CASCADE` |

#### Reference Types

When `is_reference = true`, `reference_type` specifies what kind of stable fact this is:

| reference_type | Examples | Invalidation trigger |
|----------------|----------|---------------------|
| `network_device` | Firewall IP, switch hostname, VLAN config, MAC address | New NinjaOne sync detects change |
| `software` | App version, license count, install state | New version ingested |
| `configuration` | Policy settings, baselines, thresholds | Change detected in source |
| `service_account` | Usernames, roles, permissions (**not** passwords) | Account deprovisioned |
| `contract` | SLA terms, renewal dates, pricing tiers | Renewal date passes |
| `contact` | Person phone, email, role, org details | Person leaves org |

#### Reference Detection (3 signals — any triggers `is_reference = true`)

1. **Regex pre-check** — content contains IPv4, MAC, UUID, version string (`1.2.3`), serial number, hostname, or port number patterns
2. **Connector default** — NinjaOne device connector and HaloPSA asset/contract connectors default to `is_reference = true`
3. **LLM extraction flag** — extraction schema includes `is_reference` and `reference_type` fields; LLM decides based on whether content describes a state-of-a-thing vs an event

#### Storage Tiers

```
hot  → ingested within 90 days OR high-confidence OR is_reference=true
        → active in Qdrant, truth engine processes
warm → 90 days–1 year, confidence > 0.5
        → active in Qdrant, lower priority in recall ranking
cold → archived, low-confidence, superseded (expires_at set), or truth-promoted sources
        → Postgres only; removed from Qdrant index
        → kept for audit trail, never deleted
```

The truth engine handles hot→warm→cold demotion automatically. When multiple locigrams are promoted to a Truth, the source locigrams move to `cold`. This keeps the Qdrant index lean as data accumulates.

#### Indexes

| Index | Type | Purpose |
|-------|------|---------|
| `locigrams_source_ref_unique` | UNIQUE btree (partial) | DB-enforced dedup — prevents double-ingestion even if connector bugs |
| `locigrams_locus_idx` | btree | Namespace-scoped recall |
| `locigrams_client_id_idx` | btree (partial) | Per-client queries (`WHERE client_id IS NOT NULL`) |
| `locigrams_tier_idx` | btree | Tier filtering |
| `locigrams_is_reference_idx` | btree | Knowledge vs reference queries |
| `locigrams_reference_type_idx` | btree (partial) | Reference type queries |
| `locigrams_occurred_at_idx` | btree (partial) | Temporal queries |
| `locigrams_embedding_pending_idx` | btree (partial) | Embed worker pickup — `embedding_id IS NULL AND tier IN ('hot','warm')` |
| `locigrams_entities_gin` | GIN | Array containment: `WHERE 'Acme Corp' = ANY(entities)` |
| `locigrams_metadata_gin` | GIN | JSONB key queries on connector-specific fields |
| `locigrams_fts_idx` | GIN | Full-text keyword search alongside semantic (Qdrant) search |

---

### truths

Promoted facts built from multiple reinforcing locigrams. The truth engine runs every 6 hours.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | — |
| `statement` | `TEXT` | The synthesized truth statement (LLM-generated) |
| `locus` | `TEXT` | Namespace — matches the source locigrams' locus |
| `entities` | `TEXT[]` | Entity names involved |
| `confidence` | `REAL` | `0.0–1.0`. Increases logarithmically with each reinforcement. Decays 10%/week without new signal. Archived when it drops below 0.15. |
| `source_count` | `INTEGER` | How many locigrams contributed |
| `last_seen` | `TIMESTAMPTZ` | When a locigram last reinforced this truth. Drives decay clock. |
| `locigram_ids` | `UUID[]` | The locigrams that make up this truth. Sources are demoted to `cold` tier after promotion. |
| `created_at` | `TIMESTAMPTZ` | — |
| `palace_id` | `TEXT FK` | — |

> **Note:** `is_reference = true` locigrams are **never** promoted to truths. Reference data doesn't get reinforced — it gets superseded.

---

### entities

Named entity registry. Every person, org, product, topic, or place mentioned across all locigrams.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | — |
| `name` | `TEXT` | Canonical name. `UNIQUE(palace_id, name)`. |
| `type` | `TEXT` | `person` / `org` / `product` / `topic` / `place` |
| `aliases` | `TEXT[]` | Alternative names and abbreviations. GIN-indexed. Extraction checks aliases before creating a new entity — prevents duplicates like "Acme Corp" vs "Acme Corp & Co". |
| `metadata` | `JSONB` | Additional structured data (email, phone, URL, etc.) |
| `palace_id` | `TEXT FK` | — |
| `created_at` | `TIMESTAMPTZ` | — |
| `updated_at` | `TIMESTAMPTZ` | Updated when aliases merge or metadata changes |

---

### sources

Provenance trail. Every stored locigram gets a source record linking back to the original raw item.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | — |
| `locigram_id` | `UUID FK` | References `locigrams(id) ON DELETE CASCADE` |
| `connector` | `TEXT` | Connector that produced this |
| `raw_ref` | `TEXT` | ID in the source system (e.g. M365 message ID, HaloPSA ticket number) |
| `raw_url` | `TEXT` | Deep link back to original (optional) |
| `ingested_at` | `TIMESTAMPTZ` | — |
| `palace_id` | `TEXT FK` | — |

---

### Data Flow

```
External source (email, ticket, device, conversation, manual)
    ↓
Connector pulls → RawMemory { content, sourceType, sourceRef, occurredAt, metadata }
    ↓
Pre-filter (skip noise: OOO, newsletters, duplicates by source_ref)
    ↓
LLM extraction → entities, locus, locigrams[], is_reference, reference_type
    ↓
Reference detection (3 signals: regex + connector default + LLM flag)
    ↓
Entity resolution (match by name or alias → create if new)
    ↓
Store locigrams (tier=hot, confidence filter: drop < 0.3)
    ↓
Background embed worker (30s interval) → Qdrant upsert (hot + warm only)
    ↓
Truth engine (every 6h, knowledge only)
    → Detect reinforcement groups (locus + entity overlap, 90-day window)
    → Promote to Truth (3+ locigrams = promotion threshold)
    → Demote source locigrams to cold tier
    → Remove cold locigrams from Qdrant
    → Decay truths without recent reinforcement (10%/week)
    → Archive truths below 0.15 confidence
```

## Packages

| Package | Purpose |
|---------|---------|
| `@locigram/core` | Shared types + Zod schemas |
| `@locigram/db` | Drizzle schema + raw SQL migrations |
| `@locigram/server` | Hono REST API + MCP stubs |
| `@locigram/pipeline` | Ingestion, LLM extraction, dedup, entity resolution |
| `@locigram/truth` | Truth engine — promotion, decay, confidence scoring |
| `@locigram/vector` | Qdrant wrapper — embed, upsert, search |
| `@locigram/registry` | Connector plugin registry |
| `@locigram/connector-*` | Data source connectors |

## Deploying on Kubernetes

See [`deploy/k8s/`](deploy/k8s/) for Kubernetes manifests.  
Each palace gets its own namespace, Longhorn PVCs, and NodePort services.

## Status

🚧 Early development — not ready for production use.
