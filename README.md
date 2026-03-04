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
