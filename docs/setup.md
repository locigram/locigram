# Locigram — Setup & Configuration

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

### 🟢 Ollama (local, free)

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
```

> **Recommended Ollama models by role:**
> - Embed: `nomic-embed-text`
> - Extract: `qwen2.5:7b`
> - Summary: `qwen2.5:14b` or reuse extract

---

### 🔵 OpenAI

```env
# Embed
LOCIGRAM_EMBED_URL=https://api.openai.com/v1
LOCIGRAM_EMBED_MODEL=text-embedding-3-small
LOCIGRAM_EMBED_KEY=sk-...

# Extract
LOCIGRAM_EXTRACT_URL=https://api.openai.com/v1
LOCIGRAM_EXTRACT_MODEL=gpt-4o-mini
LOCIGRAM_EXTRACT_KEY=sk-...
```

---

## Full Environment Variable Reference

### Required
| Variable | Description |
|----------|-------------|
| `PALACE_ID` | Unique slug for your palace (e.g. `yourname`) |
| `API_TOKEN` | Bearer token for API authentication |
| `POSTGRES_PASSWORD` | Postgres password |

### LLM Config
| Variable | Description |
|----------|-------------|
| `LOCIGRAM_EMBED_URL` | OpenAI-compatible embeddings endpoint |
| `LOCIGRAM_EMBED_MODEL` | Embedding model name |
| `LOCIGRAM_EXTRACT_URL` | OpenAI-compatible chat endpoint |
| `LOCIGRAM_EXTRACT_MODEL` | Chat model for entity + locus extraction |
| `LOCIGRAM_SUMMARY_URL` | (Optional) Chat endpoint for truth promotion |

### Graph & NER
| Variable | Description |
|----------|-------------|
| `MEMGRAPH_URL` | Bolt connection string e.g. `bolt://memgraph:7687` |
| `GLINER_URL` | HTTP base URL of the GLiNER NER server |

---

## Deploying on Kubernetes

See [`deploy/k8s/`](../deploy/k8s/) for Kubernetes manifests.  
Each palace gets its own namespace, Longhorn PVCs, and NodePort services.

```bash
# Apply manifest
kubectl apply -f deploy/k8s/palace-example.yaml

# Set connector secrets
kubectl create secret generic locigram-connector-secrets \
  -n locigram-main \
  --from-literal=LOCIGRAM_M365_CLIENT_SECRET='...'
```
