# Locigram — Architecture & Internal Design

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                               Locigram                                  │
│                                                                         │
│  REST API + MCP  ←→  Pipeline  ←→  Qdrant (vector search)              │
│        ↕              ↑    ↕              ↕                             │
│     Postgres    GLiNER │  LLM      Memgraph (graph)                    │
│        ↑        NER    │  extract/embed     ↑                          │
│   Connectors ──────────┘                    │                          │
│                                             │                          │
│   Background Workers ───────────────────────┘                          │
│   embed-worker · graph-worker · mention-worker · truth-engine          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Components
* **Postgres:** Source of truth for all structured data — locigrams, entities, entity_mentions, truths, SPO triples.
* **Qdrant:** Vector database for semantic search (4096-dim Cosine, collection `locigrams-main`).
* **Memgraph:** Graph database for relationship traversal — agent nodes, memory nodes, `MENTIONS` entity edges.
* **Pipeline:** Ingestion engine — GLiNER NER, LLM structured extraction, entity resolution, dedup, noise filtering.
* **GLiNER:** Fast neural NER model (`knowledgator/gliner-multitask-large-v0.5`) for entity detection. Runs on K8s (`ai-gateway` namespace). Provides evidence for entity type voting.
* **Background Workers:** Asynchronous processing for embedding, graph sync, entity mention backfill, and truth promotion.

---

## Data Flow

### Full Pipeline Path (Connector Ingest)
```
Connector → POST /api/connectors/:id/ingest
  → Dedup check (sourceRef)
  → GLiNER NER extraction (~2s, 9 entity types)
  → LLM structured extraction (SPO, category, durability, locus)
  → Entity resolution (match/create canonical entities)
  → Quality gate (noise demotion)
  → Store locigram → Postgres
  → Store entity_mentions → Postgres (GLiNER + LLM sources)
  → Store provenance → sources table
  → [async] embed-worker → Qdrant
  → [async] graph-worker → Memgraph (memory nodes + entity edges)
```

### Pre-classified Path (Structured Connectors)
Connectors that already have structured data (QBO invoices, M365 email metadata) skip LLM extraction but still get GLiNER:
```
Connector (preClassified) → POST /api/connectors/:id/ingest
  → Dedup check
  → GLiNER NER extraction (entity evidence)
  → Skip LLM (use connector-provided fields)
  → Entity resolution
  → Store locigram + entity_mentions
  → [async] embed + graph workers
```

### Remember Path (MCP / Direct API)
For manual memories from LLM sessions, Claude.ai, ChatGPT connectors:
```
MCP memory_remember / POST /api/remember
  → Direct DB insert (no LLM extraction)
  → [fire-and-forget] GLiNER → store entity_mentions
  → [async] embed + graph workers
  → [safety net] mention-worker backfills if GLiNER missed
```

---

## Entity Intelligence (Phase 9)

### Entity Mentions
Every entity detection is stored as evidence in `entity_mentions`:

| Column | Purpose |
|--------|---------|
| `raw_text` | Exact text detected (e.g. "Andrew Le") |
| `type` | Entity type (person, org, product, topic, place) |
| `confidence` | Detection confidence (0.0–1.0) |
| `source` | Who detected it: `gliner`, `llm`, or `gliner-none` (sentinel) |
| `span_start` / `span_end` | Character offsets in source text (GLiNER only) |
| `entity_id` | Link to canonical entity (nullable — unresolved mentions kept) |

### GLiNER Entity Types
```
person, organization, location, product, software, ip_address, date, event, topic
```
Mapped to canonical types: `person`, `org`, `product`, `topic`, `place`

### Confidence Floor
GLiNER detections below **0.5** confidence are discarded. The 0.5–0.7 range is the interesting audit zone for cross-linking with SuruDB.

### Type Enforcement
Entity canonical types are enforced via **majority vote**: `count(type) × avg(confidence)` per source. GLiNER high-confidence, high-volume detections naturally beat occasional LLM misclassifications. Runs during entity resolution and daily hygiene maintenance.

### Graph Integration
Memgraph stores `(Memory)-[:MENTIONS]->(Entity)` edges with confidence and source metadata. SPO triples stay in Postgres (graph = connections, Postgres = facts).

---

## Background Workers

| Worker | Interval | Purpose |
|--------|----------|---------|
| **embed-worker** | 30s | Polls locigrams with no embedding, pushes vectors to Qdrant |
| **graph-worker** | 30s | Polls locigrams with no graph sync, writes memory nodes + entity edges to Memgraph |
| **mention-worker** | 60s | Polls locigrams with no GLiNER entity_mentions, runs GLiNER, stores results. Safety net for missed detections and historical backfill |
| **truth-engine** | 6h | Detects reinforcement patterns across locigrams, promotes to truths |

---

## Maintenance Scheduler

In-process cron (replaces external K8s CronJobs). All tasks are idempotent.

| Task | Schedule | Purpose |
|------|----------|---------|
| **sweep** | `0 2 * * *` | Temporal decay — recomputes access scores |
| **durability** | `0 0,6,12,18 * * *` | TTL lifecycle — expires session/checkpoint memories |
| **dedup** | `30 3 * * *` | Deduplication sweep |
| **cluster** | `0 3 * * 0` | Co-retrieval clustering analysis |
| **noise** | `0 4 * * *` | Noise reassessment on borderline memories |
| **entity-hygiene** | `0 5 * * *` | Orphan detection, type disagreements, majority vote enforcement, stats |

Configurable via env vars: `LOCIGRAM_CRON_<NAME>` (set to `disabled` to skip). Disable all: `LOCIGRAM_MAINTENANCE_DISABLED=true`.

---

## Database Schema (Core Tables)

### `locigrams`
The central memory table.
* `content`: Memory text
* `locus`: Namespace (e.g., `people/alice`, `business/email`, `agent/main/session/...`)
* `source_ref`: Unique source ID (dedup key)
* `tier`: `hot` / `warm` / `cold` (controls Qdrant inclusion)
* `is_reference`: If true, bypasses decay and truth engine
* `category`: `decision` / `preference` / `fact` / `lesson` / `entity` / `observation` / `convention` / `checkpoint`
* `subject` / `predicate` / `object_val`: SPO triple for structured recall
* `durability_class`: `permanent` / `stable` / `active` / `session` / `checkpoint`
* `confidence`: Extraction confidence (0.0–1.0, minimum 0.3 to store)
* `connector`: Source connector name
* `connector_instance_id`: FK to connector instance (lineage tracking)

### `entity_mentions`
Evidence table for every entity detection (GLiNER + LLM).
* `locigram_id`: FK to source locigram
* `entity_id`: FK to canonical entity (nullable for unresolved)
* `raw_text`: Detected text span
* `type`: Entity type
* `confidence`: Detection confidence
* `source`: `gliner` / `llm` / `gliner-none` (sentinel — no entities found)
* `span_start` / `span_end`: Character offsets (GLiNER only)

### `entities`
Canonical entity registry.
* `name`: Primary name
* `type`: `person` / `org` / `product` / `topic` / `place`
* `aliases`: Array of alternative names
* `metadata`: Arbitrary JSON

### `truths`
Promoted facts synthesized from reinforcing locigrams.
* `source_count`: Contributing locigrams
* `confidence`: Decay-adjusted reinforcement score

### `sources`
Provenance tracking — links locigrams to their origin connector and raw reference.

---

## Structured Recall

Locigram supports both semantic search (Qdrant vectors) and exact structured queries:

```sql
-- Find all decisions about a specific subject
SELECT * FROM locigrams
WHERE palace_id = 'main'
  AND category = 'decision'
  AND subject = 'pricing';

-- Find all entity mentions with confidence
SELECT em.raw_text, em.type, em.confidence, em.source, e.name as canonical
FROM entity_mentions em
LEFT JOIN entities e ON e.id = em.entity_id
WHERE em.palace_id = 'main' AND em.type = 'person';
```

MCP tool `structured_recall` provides this via natural language queries.

---

## Connectors (Active)

| Connector | Type | Status | Items Synced | Ingestion Path |
|-----------|------|--------|-------------|----------------|
| **session-monitor** | External daemon | ✅ Active | 2,533+ | Connector ingest (full pipeline for transcripts, preClassified for checkpoints) |
| **obsidian-sync** | External | ✅ Active | 44 | Connector ingest (full pipeline) |
| **webhook** | Bundled | ✅ Always on | — | Connector ingest |

See [connectors.md](connectors.md) for the full connector framework documentation.

---

## Memory Intelligence

### Temporal Decay
The **sweep** task nightly recomputes access scores:
`score = access_count / (days_since_last_access + 1) ^ λ`

### Co-Retrieval Clustering
The **cluster** task analyzes which memories are retrieved together. Consistently paired memories are flagged for the truth engine to synthesize.

### Durability Lifecycle
The **durability** task enforces TTL by class:
* `permanent` — never expires
* `stable` — reviewed annually
* `active` — decays normally
* `session` — expires after 24h
* `checkpoint` — expires after 48h
