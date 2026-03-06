# Locigram

> Self-hosted AI memory platform. Your memories never leave your infrastructure.

Locigram is an open-source memory layer for AI assistants — addressable via MCP and REST, deployable anywhere, owned entirely by you.

## Why Locigram?

AI assistants lose context when a session ends or a platform switches (e.g., Discord to Telegram). Locigram provides **long-term persistence**:
*   **Persistent:** Decisions and facts stay with you forever.
*   **Unified:** One memory palace for all your tools (Claude, ChatGPT, OpenClaw).
*   **Intelligent:** Automatic decay of old info, reinforcement of repeating facts, and clustering of related memories.

---

## 🗺️ Documentation

*   [**Setup & Config**](docs/setup.md) — Docker/K3s deployment and environment reference.
*   [**Connectors**](docs/connectors.md) — Sync data from Email, Tickets, Devices, and Obsidian.
*   [**MCP & Integration**](docs/mcp.md) — Connecting Claude, ChatGPT, and OpenClaw.
*   [**Architecture**](docs/architecture.md) — Deep dive into the stack and data flow.

---

## 🧩 Concepts

| Term | Meaning |
|------|---------|
| **Locigram** | A single memory unit — one fact, event, or observation. |
| **Truth** | A reinforced fact built from multiple locigrams. |
| **Palace** | Your private, isolated memory store. |
| **Locus** | A namespace (e.g., `business/acme`) for scoped recall. |

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
| `@locigram/server` | Hono REST API + MCP server. |
| `@locigram/pipeline` | Ingestion, extraction, and resolution. |
| `@locigram/truth` | Truth promotion and decay engine. |
| `@locigram/connectors` | Plugins for external data sources. |
| `@locigram/core` | Shared types, interfaces (Connector, RawMemory, Palace). |
| `@locigram/registry` | Connector plugin registry and loader. |
| `@locigram/db` | Drizzle ORM schema and migrations. |
| `@locigram/vector` | Vector store operations (Qdrant). |

---

## 🔌 Connector Framework

Locigram supports three connector types for ingesting external data:

| Type | Pattern | Examples |
|------|---------|----------|
| **Scheduled** | Cron-based pull → transform → push | Gmail, Slack, HaloPSA, QBO |
| **Daemon** | Long-running, event-driven | Session monitor, file watchers |
| **Webhook** | Passive HTTP endpoint | GitHub events, Stripe |

Connector instances are managed per-palace via REST API (`/api/connectors`) and MCP tools (`connectors_list`, `connectors_create`, `connectors_sync`, `connectors_status`).

See [Connectors documentation](docs/connectors.md) for setup and configuration.

---

## 🟡 Status

**Active development.** Deployed in production, API surface stabilizing.
