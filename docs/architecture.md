# Locigram — Architecture & Internal Design

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                            Locigram                              │
│                                                                  │
│  REST API + MCP  ←→  Pipeline  ←→  Qdrant (vector search)       │
│        ↕              ↑    ↕                ↕                    │
│     Postgres    GLiNER │  LLM (embed/extract) Memgraph (graph)  │
│        ↑        NER    │                    ↑                    │
│   Connectors (M365, HaloPSA, Gmail, ...)    │                   │
│                          Background Workers ┘                    │
│          embed-worker · graph-worker · truth-engine              │
└──────────────────────────────────────────────────────────────────┘
```

### Components
*   **Postgres:** Primary source of truth for all structured data (locigrams, truths, entities).
*   **Qdrant:** High-performance vector database for semantic search.
*   **Memgraph:** Graph database enabling GraphRAG (relationship traversal).
*   **Pipeline:** Ingestion engine that handles noise filtering, LLM extraction, and entity resolution.
*   **Background Workers:** Asynchronous tasks for embedding, graph syncing, and truth promotion.

---

## Data Flow

1.  **Pull/Push:** A connector fetches data or a webhook receives a payload.
2.  **Filter:** Source-specific noise (newsletters, spam) is dropped.
3.  **Extract:** LLM parses unstructured text into discrete memory units and entities.
4.  **Detect:** The system identifies if a memory is **Knowledge** (decays) or **Reference** (stable fact).
5.  **Store:** Locigrams are written to Postgres.
6.  **Index:** Background workers push vectors to Qdrant and nodes to Memgraph.

---

## Database Schema (Core Tables)

### `locigrams`
The central table for all memories.
*   `content`: The memory text.
*   `locus`: The namespace (e.g., `people/alice`).
*   `source_ref`: Unique ID from the source system (for dedup).
*   `tier`: `hot`, `warm`, or `cold` (controls Qdrant inclusion).
*   `is_reference`: If true, bypasses decay and the truth engine.

### `truths`
Promoted facts built from multiple reinforcing locigrams.
*   `source_count`: How many locigrams contributed to this truth.
*   `confidence`: Decay-adjusted score based on reinforcement.

### `entities`
Named entity registry (People, Orgs, Topics).

---

## Memory Intelligence

### Temporal Decay
The **Sweep Worker** nightly recomputes access scores using an inverse power-law decay:
`score = access_count / (days_since_last_access + 1) ^ λ`

### Co-Retrieval Clustering
The **Cluster Worker** analyzes which memories are retrieved together. Consistently paired memories are flagged for the truth engine to synthesize into a single merged truth.
