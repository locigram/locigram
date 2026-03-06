# Locigram — Connectors

Connectors are the standardized way external data flows into Locigram. They pull, transform, and push knowledge into your palace.

> **Noise filtering:** Every connector filters spam, automated messages, and low-content records before anything reaches the LLM.

---

## Connector Framework

Locigram supports three connector types:

| Type | Pattern | Examples |
|------|---------|----------|
| **Scheduled** | Cron-based pull → transform → push | Gmail, Slack, HaloPSA, QBO, Obsidian |
| **Daemon** | Long-running, event-driven, real-time | Session monitor, filesystem watchers |
| **Webhook** | Passive HTTP endpoint, processes inbound payloads | GitHub webhooks, Stripe events |

### Connector Management API

Connector instances are managed per-palace via REST API and MCP tools.

**REST Endpoints:**
- `GET /api/connectors` — List all connector instances
- `POST /api/connectors` — Create a new connector instance
- `GET /api/connectors/:id` — Get instance details + recent syncs
- `PATCH /api/connectors/:id` — Update config/schedule/status
- `DELETE /api/connectors/:id` — Delete instance
- `POST /api/connectors/:id/sync` — Trigger manual sync
- `GET /api/connectors/:id/syncs` — Sync history

**MCP Tools:**
- `connectors_list` — List connector instances
- `connectors_create` — Create a new connector instance
- `connectors_sync` — Trigger manual sync
- `connectors_status` — Get status + recent syncs

### Database Tables

```sql
connector_instances  -- Per-palace connector configs, auth, schedule, cursor, status
connector_syncs      -- Audit log of each sync run with item counts and cursors
```

### Core Interface

```typescript
interface Connector {
  name: string
  pull(opts?: { since?: Date; limit?: number; cursor?: string }): Promise<PullResult>
  listen?(handler: (memory: RawMemory) => void): void
}

interface PullResult {
  memories: RawMemory[]
  cursor?: string     // opaque cursor for next incremental pull
  hasMore?: boolean
}

interface ConnectorPlugin {
  name: string
  version: string
  configSchema: z.ZodSchema
  create(config: unknown): Connector
}
```

---

## Available Connectors

### Microsoft 365 — Email
Incremental sync using Graph API. Each email is run through LLM extraction.
```env
LOCIGRAM_M365_TENANT_ID=your-tenant-id
LOCIGRAM_M365_CLIENT_ID=your-client-id
LOCIGRAM_M365_CLIENT_SECRET=your-client-secret
LOCIGRAM_M365_MAILBOXES=you@company.com
```

### Microsoft 365 — Teams Chat
Group channel messages by reply thread. Groups are processed once quiet for 2 hours.
*Uses the same credentials as M365 Email.*

### HaloPSA
Support tickets, assets, and contracts. Assets/contracts are ingested as reference data.
```env
LOCIGRAM_HALOPSA_URL=https://yourinstance.halopsa.com
LOCIGRAM_HALOPSA_CLIENT_ID=your-client-id
LOCIGRAM_HALOPSA_CLIENT_SECRET=your-client-secret
```

### NinjaOne
Device inventory and alerts. Ingested as reference data (`is_reference = true`).
```env
LOCIGRAM_NINJA_CLIENT_ID=your-client-id
LOCIGRAM_NINJA_CLIENT_SECRET=your-client-secret
```

### Gmail
Incremental sync via History ID. Filters spam and newsletters.
```env
LOCIGRAM_GMAIL_CLIENT_ID=your-client-id
LOCIGRAM_GMAIL_CLIENT_SECRET=your-client-secret
LOCIGRAM_GMAIL_REFRESH_TOKEN=your-refresh-token
```

### QuickBooks Online
Invoices, payments, vendor bills. Financial records are **pre-classified** (LLM extraction is skipped to preserve exact figures).
```env
LOCIGRAM_QBO_CLIENT_ID=your-client-id
LOCIGRAM_QBO_CLIENT_SECRET=your-client-secret
LOCIGRAM_QBO_REALM_ID=your-company-id
LOCIGRAM_QBO_REFRESH_TOKEN=your-refresh-token
```

---

## Daemon Connectors

### Session Monitor (`@locigram/session-monitor`)
**Type:** Daemon (event-driven, bidirectional, fleet-aware)

Watches OpenClaw agent session logs in real-time and generates handoff summaries. The most complex connector — combines daemon lifecycle, bidirectional writeback, and multi-agent fleet awareness.

**Capabilities:**
- Watches `~/.openclaw/agents/{name}/sessions/*.jsonl` for changes
- Generates LLM-powered handoff summaries every N messages or at file size thresholds
- Writes back: `active-context.json`, `live-handoff.md`, memory flush files
- Fleet discovery: scans all agent directories every 30s
- Session continuity: 15-minute resume window preserves context
- Heartbeat: per-agent liveness signals to Locigram server
- Two modes: `daemon` (persistent) and `complete` (one-shot for ephemeral agents)

**Loci produced:**
- `agent/{name}/session/{id}` — Individual session summaries
- `agent/{name}/context` — Live structured state (currentTask, pendingActions, blockers)

### Obsidian Audit & Sync
**Type:** Scheduled (audit: daily 3 AM, sync: hourly :15)

Daily vault evaluation decides what to index. Hourly sync pushes summarized notes to Locigram.

- Locus: `connectors/obsidian-sync`
- Includes `Source: path/to/note.md` for full content retrieval
- **Additive only** — connectors never delete or downgrade memories. Locigram sweep owns lifecycle.
- Audit safeguards: previously indexed notes cannot be downgraded; LLM failures preserve existing verdicts.

---

## Webhook Connector (Always Enabled)

Push content directly via REST.
```bash
curl -X POST http://localhost:3000/api/webhook/ingest \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{ "content": "Manual note content", "sourceType": "manual" }'
```

---

## Design Principles

1. **Connectors are additive feeders** — they only add/update, never delete. Locigram sweep owns memory lifecycle.
2. **Source attribution is mandatory** — every locigram traces back to its origin connector and source ID.
3. **Temporal context is first-class** — `occurredAt` enables "what did we know when?" queries.
4. **Multi-tenant isolation** — connector configs, auth, and data are palace-scoped.
5. **Idempotent syncs** — re-running a sync for the same period produces the same result.
6. **Graduated decay** — connectors can set importance hints; sweep respects them.
