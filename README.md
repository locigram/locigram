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

**3. Set your LLM** — Locigram needs two model types:

| Role | What it does | Env vars |
|------|-------------|----------|
| Embed | Converts text to vectors for semantic search | `LOCIGRAM_EMBED_URL`, `LOCIGRAM_EMBED_MODEL`, `LOCIGRAM_EMBED_KEY` |
| Extract | Parses entities, locus, and memory units from raw content | `LOCIGRAM_EXTRACT_URL`, `LOCIGRAM_EXTRACT_MODEL`, `LOCIGRAM_EXTRACT_KEY` |
| Summary | Promotes truths and summarizes (falls back to extract if not set) | `LOCIGRAM_SUMMARY_URL`, `LOCIGRAM_SUMMARY_MODEL`, `LOCIGRAM_SUMMARY_KEY` |

Each role points at any **OpenAI-compatible endpoint**. Leave `*_KEY` blank for local/unauthenticated.

**Option A — Ollama (local, free):**
```bash
ollama pull nomic-embed-text   # for embed
ollama pull qwen2.5:7b         # for extract
```
```env
LOCIGRAM_EMBED_URL=http://localhost:11434/v1
LOCIGRAM_EMBED_MODEL=nomic-embed-text

LOCIGRAM_EXTRACT_URL=http://localhost:11434/v1
LOCIGRAM_EXTRACT_MODEL=qwen2.5:7b
```

**Option B — OpenAI:**
```env
LOCIGRAM_EMBED_URL=https://api.openai.com/v1
LOCIGRAM_EMBED_MODEL=text-embedding-3-small
LOCIGRAM_EMBED_KEY=sk-...

LOCIGRAM_EXTRACT_URL=https://api.openai.com/v1
LOCIGRAM_EXTRACT_MODEL=gpt-4o-mini
LOCIGRAM_EXTRACT_KEY=sk-...

# Optional: use a larger model for truth summarization
LOCIGRAM_SUMMARY_URL=https://api.openai.com/v1
LOCIGRAM_SUMMARY_MODEL=gpt-4o
LOCIGRAM_SUMMARY_KEY=sk-...
```

**Option C — Any OpenAI-compatible API** (Together, Groq, vLLM, LM Studio, etc.):
```env
LOCIGRAM_EXTRACT_URL=https://api.groq.com/openai/v1
LOCIGRAM_EXTRACT_MODEL=llama-3.1-70b-versatile
LOCIGRAM_EXTRACT_KEY=gsk_...
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
