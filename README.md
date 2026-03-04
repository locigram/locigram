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

> **Noise filtering is built in.** Every connector filters spam, automated messages, bot traffic, and low-content records before anything reaches the LLM. Junk folder emails, Teams bot messages, marketing newsletters, OTP codes, and one-word chat replies are all dropped at the source.

---

### Microsoft 365 — Email

**What it ingests:** Email from one or more M365 mailboxes. Drafts, sent items, junk, deleted items, and automated messages (noreply, newsletters, OTP codes, calendar accept/decline) are automatically filtered out.

**How it works:** Incremental sync using the Graph API delta link. Each email is run through LLM extraction to pull entities, locus, client_id, and importance.

```env
LOCIGRAM_M365_TENANT_ID=your-tenant-id
LOCIGRAM_M365_CLIENT_ID=your-client-id
LOCIGRAM_M365_CLIENT_SECRET=your-client-secret
LOCIGRAM_M365_MAILBOXES=you@company.com,support@company.com
```

**Required Azure app registration permissions (Microsoft Graph — Application):**

| Permission | Why |
|-----------|-----|
| `Mail.Read` | Read messages from configured mailboxes |
| `User.Read.All` | Resolve sender/recipient display names |

> Grant **Application** (not delegated) permissions so the connector runs as a service account without a logged-in user. After granting, an admin must click **Grant admin consent** in the Azure portal.

---

### Microsoft 365 — Teams Chat

**What it ingests:** Channel messages from configured Teams channels. Individual messages are **grouped by reply thread**, and the full thread is sent to the LLM as a single unit once the thread goes quiet (2 hours with no new replies).

**Why thread-based?** A single message like "OK sounds good" is meaningless. The reply chain "Client firewall throwing alerts → blocked the IP → resolved, customer notified" is a complete locigram. Splitting it loses the context.

**Filters applied:** Bot/webhook messages, system events, pure acknowledgement messages ("ok", "thanks", "👍"), and threads under 20 total words are all dropped.

```env
# Same credentials as email — no additional vars needed
LOCIGRAM_M365_TENANT_ID=your-tenant-id
LOCIGRAM_M365_CLIENT_ID=your-client-id
LOCIGRAM_M365_CLIENT_SECRET=your-client-secret
# Teams channels are configured in your palace config, not env vars
```

**Required Azure app registration permissions (Microsoft Graph — Application):**

| Permission | Why |
|-----------|-----|
| `ChannelMessage.Read.All` | Read channel messages and replies |
| `Team.ReadBasic.All` | List teams and channels |
| `User.Read.All` | Resolve participant display names |

> **Note:** `ChannelMessage.Read.All` is a protected permission and requires Microsoft to review and approve your app for production use. For personal/internal use, enable it under your own tenant — it does not require external review.

---

### HaloPSA

**What it ingests:** Support tickets — title, description, notes, resolution. Assets and contracts are ingested as **reference data** (stable facts that don't decay).

**Filters applied:** Internal-only test tickets, closed tickets with no notes, and auto-generated system tickets are skipped.

```env
LOCIGRAM_HALOPSA_URL=https://yourinstance.halopsa.com
LOCIGRAM_HALOPSA_CLIENT_ID=your-client-id
LOCIGRAM_HALOPSA_CLIENT_SECRET=your-client-secret
```

**Required HaloPSA API permissions:**

| Scope | Why |
|-------|-----|
| `read:tickets` | Read ticket list, details, and notes |
| `read:assets` | Read asset inventory (ingested as reference) |
| `read:contracts` | Read contracts and SLAs (ingested as reference) |
| `read:clients` | Resolve client names and IDs |

> In HaloPSA: **Admin → Integrations → API → New Application**. Set grant type to `client_credentials`. Assign the scopes above.

---

### NinjaOne

**What it ingests:** Devices and alerts. **All device records are ingested as reference data** (`is_reference = true`) — they're stable facts about what exists, not events.

```env
LOCIGRAM_NINJA_CLIENT_ID=your-client-id
LOCIGRAM_NINJA_CLIENT_SECRET=your-client-secret
```

**Required NinjaOne API permissions:**

| Permission | Why |
|-----------|-----|
| `Monitoring` | Read device status and alerts |
| `Management` | Read device inventory and details |
| `Reporting` | Read organization/client rollup data |

> In NinjaOne: **Administration → Apps → API → Add**. Set application type to `API Services (machine-to-machine)`. Assign the scopes above. NinjaOne uses client credentials flow — no redirect URI needed.

---

### Gmail

**What it ingests:** Email from a Gmail account. Same noise filters as M365 email — spam, promotions, OTP codes, automated notifications, and very short messages are filtered out.

**How it works:** Uses the Gmail API with incremental sync via `historyId`. Requires a refresh token obtained via OAuth2 consent flow.

```env
LOCIGRAM_GMAIL_CLIENT_ID=your-client-id
LOCIGRAM_GMAIL_CLIENT_SECRET=your-client-secret
LOCIGRAM_GMAIL_REFRESH_TOKEN=your-refresh-token
```

**Required Google Cloud OAuth2 scopes:**

| Scope | Why |
|-------|-----|
| `https://www.googleapis.com/auth/gmail.readonly` | Read messages and labels |

> In Google Cloud Console: create an **OAuth 2.0 Client ID** (desktop app type). Run a one-time OAuth consent flow to obtain the refresh token — tools like [`gcloud`](https://cloud.google.com/sdk) or [`google-auth-library`](https://github.com/googleapis/google-auth-library-nodejs) can do this. Store the refresh token — it stays valid until revoked.

---

### QuickBooks Online

**What it ingests:** Invoices, customer payments, vendor bills, and time activities. Financial records are **pre-classified** — exact dollar amounts are stored in JSONB metadata and never passed through the LLM, eliminating any risk of the model paraphrasing a dollar figure incorrectly.

**LLM extraction is skipped for financial data.** Entities, locus, and classification are set directly from QBO's structured data. The LLM is only involved if you push QBO data via webhook manually.

**Classification:**
- Invoices and vendor bills → `is_reference = true` (stable transaction facts)
- Customer payments and time activities → `is_reference = false` (events, feed truth engine)
- Line items are classified as `recurring` (MRR — endpoints, security, backup, M365) vs `project` based on item name patterns

```env
LOCIGRAM_QBO_CLIENT_ID=your-client-id
LOCIGRAM_QBO_CLIENT_SECRET=your-client-secret
LOCIGRAM_QBO_REALM_ID=your-company-id          # from QBO URL: ?realmId=XXXXXXX
LOCIGRAM_QBO_REFRESH_TOKEN=your-refresh-token
LOCIGRAM_QBO_ACCESS_TOKEN=                     # optional — auto-refreshed
LOCIGRAM_QBO_MINOR_VERSION=                    # optional — e.g. 65
```

**Required Intuit developer app scopes:**

| Scope | Why |
|-------|-----|
| `com.intuit.quickbooks.accounting` | Read invoices, payments, bills, time activities |

> In the [Intuit Developer Portal](https://developer.intuit.com): create an app, select **QuickBooks Online and Payments**, enable the accounting scope. Generate a refresh token via the OAuth2 playground or a one-time consent flow. Refresh tokens expire after 100 days of inactivity — keep them warm with periodic syncs.

---

### Webhook (always enabled)

Push any content directly — no connector setup required. Use this for LLM session summaries, manual notes, or any source without a dedicated connector.

```bash
curl -X POST http://localhost:3000/api/webhook/ingest \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Alice from Acme called about the renewal. She wants to add 5 seats.",
    "sourceType": "manual",
    "metadata": { "client_id": "acme" }
  }'
```

**sourceType options:** `email` · `chat` · `sms` · `call` · `ticket` · `device` · `calendar` · `contact` · `invoice` · `payment` · `bill` · `vendor-payment` · `timesheet` · `contract` · `llm-session` · `note` · `manual` · `webhook` · `system`

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

#### OpenClaw integration

OpenClaw integrates with Locigram via **MCP** — not a custom connector. Configure Locigram as an MCP server in your OpenClaw config and it works out of the box for any install:

- **Write path** — OpenClaw calls `memory_remember()` MCP tool at session end to store summaries
- **Read path** — OpenClaw calls `memory_search()` MCP tool during conversation for recall

MCP endpoint: `http://<your-locigram-host>/mcp` (see MCP section below).

#### Session Monitor (`@locigram/session-monitor`)

A daemon that watches OpenClaw agent session JSONL files and generates handoff summaries. Supports both **permanent** (long-running daemon) and **ephemeral** (one-shot completion) agent types.

**Outputs per handoff cycle:**
- **`live-handoff.md`** — narrative markdown summary (current task, decisions, files changed, next steps)
- **`active-context.json`** — structured JSON state (currentTask, currentProject, pendingActions, recentDecisions, blockers, activeAgents, domain)

**Locus hierarchy:** Data is organized hierarchically in Locigram:
- `agent/{name}/session/{sessionId}` — individual session summaries
- `agent/{name}/context` — current active context (structured state)
- `agent/{name}/heartbeat` — liveness signals (every 10 min)

**Multi-instance:** Each agent gets its own named system service (`com.locigram.session-monitor.{agentName}` on macOS, `locigram-session-monitor-{agentName}.service` on Linux). Multiple agents coexist without conflict.

**Fleet status:** `GET /api/context/fleet` returns all agents' current state — useful for a main agent to get a standup view.

**Ephemeral agents:** Use `locigram-session-monitor complete` at end of task for a one-shot summary push.

Features: task-aware summarization with domain detection, startup reconciliation, pending action drift detection, session continuity, heartbeat, fleet status query, end-of-session final snapshot.

See [`packages/connectors/session-monitor/README.md`](packages/connectors/session-monitor/README.md) for full documentation.

**Agent workspace integration** — connecting the session monitor to an OpenClaw agent requires changes to both the install config and the agent's workspace files (SOUL.md, AGENTS.md). See [`docs/openclaw-integration.md`](docs/openclaw-integration.md) for the complete guide.

#### External connectors (pull-based — activate by setting env vars)
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
| `LOCIGRAM_QBO_CLIENT_ID` | QuickBooks Online | Intuit app client ID |
| `LOCIGRAM_QBO_CLIENT_SECRET` | QuickBooks Online | Intuit app client secret |
| `LOCIGRAM_QBO_REALM_ID` | QuickBooks Online | Company ID (from QBO URL) |
| `LOCIGRAM_QBO_REFRESH_TOKEN` | QuickBooks Online | OAuth2 refresh token |
| `LOCIGRAM_QBO_ACCESS_TOKEN` | QuickBooks Online | _(optional)_ — auto-refreshed |
| `LOCIGRAM_QBO_MINOR_VERSION` | QuickBooks Online | _(optional)_ API minor version |

---

## MCP Integration

Locigram exposes an **MCP (Model Context Protocol) server** at `/mcp`. This is the primary integration point for OpenClaw and any AI assistant that supports MCP.

**Endpoint:** `http://<your-locigram-host>/mcp`
**Auth:** `Authorization: Bearer <API_TOKEN>`
**Transport:** Streamable HTTP (MCP spec 2025-03-26)

---

### Wiring to OpenClaw via mcporter

OpenClaw uses [mcporter](https://mcporter.dev) as its MCP client runtime. Follow these steps to connect Locigram to any OpenClaw agent.

#### Step 1 — Install mcporter

```bash
npm install -g mcporter
# verify
mcporter --version
```

#### Step 2 — Register the Locigram server

mcporter stores server configs in `~/.mcporter/mcporter.json` (system-wide) or `<workspace>/config/mcporter.json` (per-agent).

**System-wide (recommended — works for all agents regardless of working directory):**

```bash
# Create system config directory
mkdir -p ~/.mcporter

# Write the config
cat > ~/.mcporter/mcporter.json << 'EOF'
{
  "mcpServers": {
    "locigram": {
      "baseUrl": "http://<your-locigram-host>/mcp",
      "headers": {
        "Authorization": "Bearer <your-api-token>"
      }
    }
  },
  "imports": []
}
EOF
```

**Or add via CLI (writes to per-project config):**
```bash
mcporter config add locigram http://<your-locigram-host>/mcp \
  --header "Authorization=Bearer <your-api-token>"
```

#### Step 3 — Verify the connection

```bash
# List tools — should show all 12
mcporter list locigram

# Test a live call
mcporter call locigram.palace_stats
mcporter call locigram.memory_session_start --args '{"locus":"agent/main","lookbackDays":7}'
```

Expected output from `memory_session_start`:
```json
{
  "recentMemories": [...],
  "truths": [...],
  "summary": "Found N recent memories and M truths from the last 7 days."
}
```

#### Step 4 — Add recovery call to each agent's SOUL.md

Add this block to the `SOUL.md` of every persistent OpenClaw agent (substitute the correct locus per agent):

```markdown
## 🧠 Locigram Memory Recovery (Post-Compaction)

After any context compaction, run this via exec to recover your active state:

\`\`\`bash
mcporter call locigram.memory_session_start --args '{"locus":"agent/<name>","lookbackDays":7}'
\`\`\`

Returns: recent decisions, active context, high-importance items from the last 7 days.
Compare against current task — anything in-flight not being addressed is a gap.

**Fallback (if Locigram MCP unavailable):** Fall back to project pages + live-handoff.md.
```

**Agent loci to use:**

| Agent type | Locus |
|---|---|
| Main / default session | `agent/main` |
| Monitoring agent | `agent/watcher` |
| Business operations agent | `agent/msp` |
| Infrastructure / DevOps agent | `agent/devops` |
| Custom agent | `agent/<your-name>` |

#### Step 5 — Verify tools are callable from the agent

From within an OpenClaw session, the agent can call any Locigram tool via exec:

```bash
# Recall memories about a topic
mcporter call locigram.memory_recall --args '{"query":"project decisions last week","limit":5}'

# Look up everything about a client/account
mcporter call locigram.memory_client --args '{"clientId":"acme-corp"}'

# Store a new memory
mcporter call locigram.memory_remember --args '{"content":"Decided to use Streamable HTTP for MCP transport","locus":"project/locigram"}'

# Correct a wrong memory
mcporter call locigram.memory_correct --args '{"oldId":"<uuid>","correction":"The correct information"}'
```

#### Notes

- The mcporter system config (`~/.mcporter/mcporter.json`) is loaded automatically — no `--config` flag needed
- Per-workspace config (`<workspace>/config/mcporter.json`) takes precedence over system config when both exist
- The Locigram API token is the `API_TOKEN` value from your `palace-*.yaml` (or `LOCIGRAM_API_TOKEN` env var)
- MCP session TTL is 30 minutes — mcporter handles reconnection transparently

### MCP Tools (12 total)

#### Read
| Tool | Description |
|------|-------------|
| `memory_recall` | Semantic search via Qdrant. Returns scored locigrams for a query. Optional locus filter. |
| `memory_context` | Proactive context for current task. Hybrid recency + semantic. |
| `memory_client` | All memories for a specific client ID. Business use case: pull everything known about a client before an interaction. |
| `memory_reference` | Precise lookup for stable reference data (IPs, contracts, contacts, software versions). Authoritative, not semantic. |
| `memory_session_start` | **Compaction recovery.** Returns recent decisions + active context for a given agent locus. Call this immediately after context compaction to recover state. |
| `people_lookup` | All memories and entity profile for a named person. |
| `truth_get` | High-confidence promoted facts only. Min confidence filter. |
| `recent_activity` | Browse memories by time window. |
| `palace_stats` | Locigram count, truth count, palace info. |

#### Write
| Tool | Description |
|------|-------------|
| `memory_remember` | Store a new memory. Direct insert + embed + upsert to Qdrant. |
| `memory_forget` | Expire a memory. Use when something is no longer true. |
| `memory_correct` | Supersede a wrong memory with a correction. Immutable audit trail — old memory is expired, not deleted. |

### Agent Compaction Recovery

Each persistent agent uses `memory_session_start` on post-compaction recovery, scoped to its own locus (`agent/main`, `agent/watcher`, etc.). This is wired directly into each agent's `SOUL.md` so it runs automatically on context restart.

```
On compaction recovery:
  1. Call memory_session_start(locus='agent/<name>', lookbackDays=7)
  2. Returns: recent decisions, active context, high-importance items
  3. Compare against current task — nothing falls through
  4. Fallback: read project pages + live-handoff.md if MCP unavailable
```

Built-in agent loci:

| Agent | Locus | Additional tools wired in SOUL.md |
|-------|-------|----------------------------------|
| Main session | `agent/main` | — |
| Watcher | `agent/watcher` | — |
| MSP / business ops | `agent/msp` | `memory_client` for pre-interaction context |
| DevOps | `agent/devops` | `memory_reference` for infrastructure lookups |

To wire your own OpenClaw agent: add the `memory_session_start` call to its `SOUL.md` with the appropriate locus.

---

## Multi-Agent Setup

Locigram supports multiple agents pushing context simultaneously. Each agent is either **permanent** or **ephemeral** (`LOCIGRAM_AGENT_TYPE` env var).

### Permanent agents

Long-running agents with dedicated session monitors. Each gets its own LaunchAgent (macOS) or systemd unit (Linux). Pushes ongoing context to `agent/{name}/context` + heartbeats every 10 minutes. Appears in fleet status.

```bash
# Install session monitor for "main" agent
OPENCLAW_AGENT_NAME=main LOCIGRAM_URL=... LOCIGRAM_API_TOKEN=... \
  locigram-session-monitor install

# Install for "devops" agent (separate service, separate logs)
OPENCLAW_AGENT_NAME=devops LOCIGRAM_URL=... LOCIGRAM_API_TOKEN=... \
  locigram-session-monitor install
```

### Ephemeral agents

Spawned for specific tasks, complete and exit. Push to `agent/{name}/session/{sessionId}` only — they do **not** push to `agent/{name}/context` and therefore do **not** appear in fleet status.

```bash
export LOCIGRAM_AGENT_TYPE=ephemeral
export OPENCLAW_AGENT_NAME=task-runner-42

# ... agent does work ...

# When done, push completion summary and exit
locigram-session-monitor complete
```

### Fleet status (permanent agents only)

Query all permanent agents' current state via the fleet endpoint (queries `agent/*/context` loci):

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3000/api/context/fleet
```

Returns each agent's `currentTask`, `currentProject`, `blockers`, `domain`, `lastSeen`, and `agentType`.

### active-context.json

Auto-maintained structured JSON state written alongside each handoff dump. Never edit manually — the session monitor owns this file. Contains `currentTask`, `currentProject`, `pendingActions`, `recentDecisions`, `blockers`, `activeAgents`, `domain`, plus metadata fields (`_autoUpdated`, `_sessionId`, `_finalSnapshot`).

### Locus hierarchy

Agent data is organized hierarchically:

| Locus | Written by | Purpose |
|-------|-----------|---------|
| `agent/{name}/session/{sessionId}` | Both permanent and ephemeral | Individual session summaries |
| `agent/{name}/context` | Permanent only | Current active context (structured JSON). Powers fleet status. |
| `agent/{name}/heartbeat` | Permanent only | Liveness signals (every 10 min) |

Legacy flat loci (`agent/{name}`) are automatically mapped to `agent/{name}/context`.

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

- **Postgres** — structured storage (locigrams, truths, entities, sources, retrieval_events)
- **Qdrant** — vector search for semantic recall (hot + warm tier only; cold = Postgres-only)
- **Pipeline** — ingests raw content, calls LLM to extract entities + memory units
- **Truth engine** — promotes repeated facts into truths with confidence scores; merges co-retrieved clusters
- **Connectors** — pull from external sources; auto-activated by env vars
- **Sweep worker** — nightly K8s CronJob (2am); two bulk SQL statements — CTE computes inverse power-law decay scores + updates tiers in one roundtrip; second statement queues cold noise for LLM re-assessment; near-zero memory footprint at any scale
- **Cluster worker** — weekly K8s CronJob; co-occurrence analysis on retrieval history, flags frequently co-retrieved locigrams for truth merging

**Two ingestion paths:**

| Path | When to use | LLM extraction |
|------|-------------|----------------|
| Standard | Unstructured content (emails, chat, tickets) | ✅ Yes — entities, locus, classification extracted by LLM |
| `preClassified` | Structured data (financial records, device inventory, contacts) | ❌ Skipped — connector sets entities/locus/classification directly from source data |

The `preClassified` path exists because structured data (a QBO invoice, a NinjaOne device record) is already perfectly categorized — running it through an LLM adds latency, cost, and introduces transcription risk (e.g. the LLM paraphrasing `$7,500.00` as "around $7,500").

**Noise filtering is applied before either path:**  
Each connector filters its own source-specific noise — spam folders, bot messages, automated notifications, OTP codes, marketing emails, sub-20-word chat threads — before content ever reaches the pipeline.

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
| `connector` | `TEXT` | `NULL` | Which connector produced this: `openclaw`, `microsoft365`, `halopsa`, `ninjaone`, `webhook`, etc. |
| **Temporal** | | | |
| `occurred_at` | `TIMESTAMPTZ` | `NULL` | When the underlying event happened (e.g. email received date). Distinct from `created_at` (ingest time). Index allows temporal queries: "what did we know about X in Q4?" |
| `created_at` | `TIMESTAMPTZ` | `NOW()` | When this locigram was ingested |
| `expires_at` | `TIMESTAMPTZ` | `NULL` | `NULL` = active. Set when superseded (reference data) or decayed below threshold (knowledge). Record is kept for audit — never deleted. |
| **Classification** | | | |
| `locus` | `TEXT` | — | Memory namespace. Format: `people/name`, `business/orgname`, `technical/topic`, `personal/topic`, `project/name`, `agent/name`. Used for scoped recall. |
| `client_id` | `TEXT` | `NULL` | First-class MSP client filter. Allows "show me everything about a client" across all connectors. |
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
| **Access scoring** | | | |
| `access_count` | `INT` | `0` | Incremented every time this locigram is returned by a recall query. |
| `last_accessed_at` | `TIMESTAMPTZ` | `NULL` | Timestamp of last recall hit. `NULL` = never retrieved. |
| `access_score` | `FLOAT` | `1.0` | Recomputed nightly by sweep worker using inverse power-law decay: `access_count / (days_since_last_access + 1) ^ λ`. Controls tier transitions. |
| `cluster_candidate` | `BOOLEAN` | `false` | Set by cluster worker when this locigram frequently co-occurs with others in recall queries. Truth engine picks these up for summarization and merging. |

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
hot  → recently active (high access_score) OR is_reference=true
        → active in Qdrant; truth engine + cluster worker process these
warm → moderate access_score; older but still occasionally retrieved
        → active in Qdrant; lower priority in recall ranking
cold → low access_score; superseded by a truth; or truth-promoted sources
        → Postgres only; removed from Qdrant index
        → kept for audit trail, never deleted
        → candidates for LLM noise re-assessment (may be expired if confirmed garbage)
```

#### Temporal Decay — How Tiers Are Managed

Tiers are not assigned once and forgotten. A **sweep worker** (K8s CronJob, runs nightly at 2am) recomputes every locigram's `access_score` using an **inverse power-law decay function** modelled on the **Ebbinghaus Forgetting Curve** — the scientific basis for how human memory fades:

```
access_score = access_count / (days_since_last_access + 1) ^ λ
```

- `access_count` — incremented every time this locigram is returned in a recall query
- `days_since_last_access` — computed at sweep time, not stored
- `λ` (lambda) — **decay factor** (**confirmed default: `0.6`**); higher = faster forgetting

The score is *recomputed*, not decremented. This means no write-heavy decay daemon, no drift if the job misses a night, and the formula self-corrects on the next run.

**Implementation: two SQL statements, not a row loop.** The sweep uses a CTE to compute all scores inline in Postgres and updates every row in a single bulk UPDATE. A second statement queues cold + very-low-score locigrams for LLM noise re-assessment. Two roundtrips total regardless of table size — near-zero memory on the pod, finishes in seconds at any realistic scale.

> **Plain English:** The score is *how often is this memory used, penalized by how long it's been idle.* Same access count — time kills the score. A memory retrieved 10 times last week scores high. That same memory retrieved 10 times but six months ago scores low.

**Concrete examples at λ=0.6:**

| Memory | Accesses | Last retrieved | Score | Tier |
|--------|----------|----------------|-------|------|
| "Acme Corp uses Lacerte for tax season" | 20 | 2 days ago | ~14.9 | 🔥 hot |
| "Contoso has 13 managed devices" | 5 | 30 days ago | ~0.6 | 🌤 warm |
| "Meeting note from January" | 2 | 90 days ago | ~0.08 | 🧊 cold |
| Automated notification nobody retrieved | 0 | never | 0 | 🗑 noise queue |

**λ and thresholds are independent.** λ shapes the decay curve. Thresholds decide when to act on it.

| λ value | Time to go cold (from 1 access) |
|---------|----------------------------------|
| `0.3` | ~2 years |
| `0.6` | **~6 months** ← confirmed default |
| `0.8` | ~6 weeks |
| `1.0` | ~3 weeks |

**Tier transition thresholds (configurable):**

| Condition | Action |
|-----------|--------|
| `access_score < 0.3` AND `tier = hot` | Demote to `warm` |
| `access_score < 0.1` AND `tier = warm` | Demote to `cold` |
| `access_score < 0.05` AND `tier = cold` AND `is_reference = false` | Queue for LLM noise re-assessment |
| LLM confirms noise (spam / zero-context / orphaned) | Set `expires_at = NOW()` |

`is_reference = true` locigrams (device facts, contracts, contacts) are **exempt from decay** — reference data stays hot regardless of access frequency.

#### Co-Retrieval Clustering

Every recall query logs the returned locigram IDs to a `retrieval_events` table. A **cluster worker** (K8s CronJob, runs weekly) analyzes pairwise co-occurrence: locigrams that are consistently retrieved together across many queries are flagged as `cluster_candidate = true`.

The truth engine picks up candidates, groups them transitively, runs LLM summarization on each group, and stores a single merged truth. Source locigrams move to `cold` and their Qdrant vectors are replaced by the merged truth's vector.

This is a more direct truth promotion signal than time-based reinforcement: co-retrieval means the system is literally proving these memories belong together through usage.

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
| `aliases` | `TEXT[]` | Alternative names and abbreviations. GIN-indexed. Extraction checks aliases before creating a new entity — prevents duplicates like "Acme Corp" vs "Acme Corporation". |
| `metadata` | `JSONB` | Additional structured data (email, phone, URL, etc.) |
| `palace_id` | `TEXT FK` | — |
| `created_at` | `TIMESTAMPTZ` | — |
| `updated_at` | `TIMESTAMPTZ` | Updated when aliases merge or metadata changes |

---

### retrieval_events

Co-retrieval log. Every recall query appends one row recording which locigram IDs were returned. The cluster worker uses this table to compute pairwise co-occurrence frequencies and identify memories that belong together.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | — |
| `palace_id` | `TEXT FK` | References `palaces(id) ON DELETE CASCADE` |
| `query_text` | `TEXT` | The original search query (for debugging/analysis) |
| `locigram_ids` | `TEXT[]` | All locigram IDs returned in this query result — GIN indexed |
| `retrieved_at` | `TIMESTAMPTZ` | — |

The cluster worker runs a pairwise unnest query across this table (30-day window) to count how often each pair of locigrams appears together. Pairs above `LOCIGRAM_CLUSTER_MIN_COOCCURRENCE` (default: 5) get `cluster_candidate = true` set on both records.

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
