# Locigram

> Self-hosted AI memory platform. Your memories never leave your infrastructure.

Locigram is an open-source memory layer for AI assistants — addressable via MCP and REST, deployable anywhere, owned entirely by you.

## Why Locigram?

AI assistants lose context when a session ends or a platform switches. Locigram provides **long-term persistence**:

- **Persistent** — Decisions and facts survive compaction, session resets, and platform changes.
- **Unified** — One memory palace for all your tools (Claude, ChatGPT, OpenClaw, custom agents).
- **Intelligent** — Automatic decay, truth reinforcement from repeated observations, and entity clustering.
- **Connectable** — Standardized connector framework to feed data from any source.
- **Private** — Self-hosted. Your data never leaves your infrastructure.

---

## 🗺️ Documentation

- [**Setup & Config**](docs/setup.md) — Docker/K3s deployment and environment reference.
- [**Connectors**](docs/connectors.md) — Feed data from Email, Tickets, Notes, Sessions, and more.
- [**MCP & Integration**](docs/mcp.md) — Connecting Claude, ChatGPT, and OpenClaw.
- [**Architecture**](docs/architecture.md) — Deep dive into the stack and data flow.

---

## 🧩 Concepts

| Term | Meaning |
|------|---------|
| **Locigram** | A single memory unit — one fact, event, or observation. |
| **Truth** | A reinforced fact built from multiple locigrams. |
| **Palace** | Your private, isolated memory store. Multi-tenant by design. |
| **Locus** | A namespace (e.g., `business/acme`) for scoped recall. |
| **Connector** | A standardized data feeder — pulls from external sources, pushes into your palace. |

---

## 🚀 Quick Start (Ollama)

```bash
docker compose up -d
```

*Requires Ollama with `nomic-embed-text` and `qwen2.5:7b`.*

---

## 🛠️ Package Layout

| Package | Role |
|---------|------|
| `@locigram/server` | Hono REST API + MCP server + connector scheduler. |
| `@locigram/pipeline` | Ingestion, extraction, embedding, and entity resolution. |
| `@locigram/truth` | Truth promotion, reinforcement, and decay engine. |
| `@locigram/core` | Shared types and interfaces (`Connector`, `RawMemory`, `Palace`). |
| `@locigram/registry` | Connector plugin registry and loader. |
| `@locigram/db` | Drizzle ORM schema and idempotent migrations. |
| `@locigram/vector` | Vector store operations (Qdrant). |

### Connector Packages

| Package | Type | Description |
|---------|------|-------------|
| `@locigram/connector-webhook` | Bundled | Generic inbound push endpoint. |
| `@locigram/connector-gmail` | Bundled | Google email via API. |
| `@locigram/connector-m365` | Bundled | Microsoft email + Teams via Graph API. |
| `@locigram/connector-obsidian-audit` | External | Vault note evaluation + indexing. |
| `@locigram/connector-obsidian-sync` | External | Vault note summarization + ingestion. |
| `@locigram/connector-session-monitor` | External | OpenClaw agent session tracking. |

---

## 🔌 Connector Framework

Connectors are the standardized way external data flows into Locigram. Every memory traces back to its source connector with full data lineage.

### Distribution Model

**Bundled** connectors ship with Locigram and run in-process via the built-in scheduler.
**External** connectors run as their own container/process and communicate via authenticated REST API.

| Type | Pattern | Examples |
|------|---------|----------|
| **Scheduled** | Cron-based pull → transform → push | Gmail, Obsidian, HaloPSA |
| **Daemon** | Long-running, event-driven | Session monitor, file watchers |
| **Webhook** | Passive HTTP endpoint | GitHub events, Stripe |

### Authentication

External connectors authenticate with **scoped connector tokens** (`lc_` prefix):

- **Palace-scoped** — can only write to the palace it belongs to.
- **Instance-scoped** — can only operate on its own connector instance.
- **Least privilege** — ingest memories, report sync status, read own cursor. Nothing else.
- **Rotatable** — admin can rotate/revoke without affecting other connectors.
- **Hashed at rest** — SHA-256, same pattern as OAuth tokens.

### Data Lineage

Every locigram ingested via a connector is tagged with `connector_instance_id`. This enables:

- **"Show me everything this connector pushed"** — `WHERE connector_instance_id = :id`
- **Surgical cleanup** — delete or expire all data from a misbehaving connector.
- **Cascade options** — `DELETE /api/connectors/:id?data=keep|delete|expire`

### Connector API

```bash
# Admin: create a connector instance (returns scoped token)
curl -X POST /api/connectors \
  -H "Authorization: Bearer $PALACE_TOKEN" \
  -d '{"connectorType": "halopsa", "name": "HaloPSA Tickets", "distribution": "external"}'

# Connector: push memories (server enforces lineage)
curl -X POST /api/connectors/$ID/ingest \
  -H "Authorization: Bearer $CONNECTOR_TOKEN" \
  -d '{"memories": [{"content": "...", "sourceType": "ticket", "sourceRef": "T-1234"}]}'

# Connector: report sync results
curl -X POST /api/connectors/$ID/report \
  -H "Authorization: Bearer $CONNECTOR_TOKEN" \
  -d '{"itemsPulled": 25, "itemsPushed": 20, "itemsSkipped": 5}'
```

See [Connectors documentation](docs/connectors.md) for the full API reference and building your own.

---

## 🔑 MCP & OAuth

Locigram exposes an MCP server for direct integration with AI assistants:

| Client | Auth | Status |
|--------|------|--------|
| Claude.ai | OAuth (dynamic registration) | ✅ |
| ChatGPT | OAuth (manual client setup) | ✅ |
| OpenClaw | Bearer token | ✅ |
| Custom agents | Bearer token or OAuth | ✅ |

MCP tools: `memory_remember`, `memory_recall`, `memory_session_start`, `connectors_list`, `connectors_create`, `connectors_sync`, `connectors_status`.

---

## 🟢 Status

**Production.** Deployed on K3s, API surface stable, connector framework live with data lineage.
