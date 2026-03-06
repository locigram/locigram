# Locigram — Connectors

Connectors are the standardized way external data flows into Locigram. They pull, transform, and push knowledge into your palace.

> **Noise filtering:** Every connector filters spam, automated messages, and low-content records before anything reaches the LLM.

---

## Distribution Model

Locigram supports two connector distribution models:

### Bundled Connectors
Ship with the Locigram server image. Run in-process, managed by the built-in scheduler. Zero setup beyond providing credentials.

| Connector | Description |
|-----------|-------------|
| Gmail | Google email via API |
| M365 (Email + Teams) | Microsoft email + chat via Graph API |
| Webhook | Generic inbound push endpoint (always enabled) |

### External Connectors
Run as their own Docker container or process. Communicate with Locigram via authenticated API. Use when the connector is industry-specific, needs host access, or is a long-running daemon.

| Connector | Description |
|-----------|-------------|
| HaloPSA | PSA tickets, assets, contracts |
| QuickBooks Online | Invoices, payments, vendor bills |
| NinjaOne | RMM device inventory, alerts |
| Obsidian | Vault audit + sync (needs filesystem) |
| Session Monitor | OpenClaw agent sessions (daemon, needs filesystem) |
| Slack | Channel history + webhook events |
| GitHub | Issue/PR discussions, webhook events |

---

## Connector Types

| Type | Pattern | Examples |
|------|---------|----------|
| **Scheduled** | Cron-based pull → transform → push | Gmail, Obsidian, HaloPSA |
| **Daemon** | Long-running, event-driven, real-time | Session monitor, file watchers |
| **Webhook** | Passive HTTP endpoint, processes inbound | GitHub events, Stripe |

---

## Authentication

### Bundled Connectors
Run inside the server process — no separate auth needed. Credentials are provided via env vars.

### External Connectors
Each connector instance gets a **scoped connector token** at creation time.

```bash
# Admin creates a connector instance (requires palace API token)
curl -X POST https://your-locigram/api/connectors \
  -H "Authorization: Bearer $PALACE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"connectorType": "halopsa", "name": "HaloPSA Tickets"}'

# Response includes the connector token (shown once, store it!)
# { "id": "...", "token": "lc_abc123..." }
```

The connector then uses this token for all API calls:

```bash
# Connector pushes memories
curl -X POST https://your-locigram/api/ingest \
  -H "Authorization: Bearer lc_abc123..." \
  -d '{"content": "...", "sourceType": "ticket", "sourceRef": "T-1234"}'

# Connector reports sync completion
curl -X POST https://your-locigram/api/connectors/INSTANCE_ID/sync \
  -H "Authorization: Bearer lc_abc123..."
```

**Token properties:**
- Palace-scoped (can only write to its palace)
- Instance-scoped (can only operate on its own connector)
- Rotatable and revocable by admin
- SHA-256 hashed at rest

---

## Connector Management API

Connector instances are managed per-palace via REST API and MCP tools.

### REST Endpoints (admin — palace API token)
- `GET /api/connectors` — List all connector instances
- `POST /api/connectors` — Create instance (returns connector token)
- `GET /api/connectors/:id` — Get details + recent syncs
- `PATCH /api/connectors/:id` — Update config/schedule/status
- `DELETE /api/connectors/:id` — Delete instance + revoke token
- `POST /api/connectors/:id/token/rotate` — Rotate connector token

### REST Endpoints (connector — connector token)
- `GET /api/connectors/:id` — Read own status/cursor
- `POST /api/connectors/:id/sync` — Report sync completion
- `POST /api/ingest` — Push memories (tagged with connector ID)

### MCP Tools
- `connectors_list` — List connector instances
- `connectors_create` — Create a new connector instance
- `connectors_sync` — Trigger manual sync
- `connectors_status` — Get status + recent syncs

---

## Bundled Connector Setup

### Gmail
```env
LOCIGRAM_GMAIL_CLIENT_ID=your-client-id
LOCIGRAM_GMAIL_CLIENT_SECRET=your-client-secret
LOCIGRAM_GMAIL_REFRESH_TOKEN=your-refresh-token
```

### Microsoft 365 — Email + Teams
```env
LOCIGRAM_M365_TENANT_ID=your-tenant-id
LOCIGRAM_M365_CLIENT_ID=your-client-id
LOCIGRAM_M365_CLIENT_SECRET=your-client-secret
LOCIGRAM_M365_MAILBOXES=you@company.com
```

### Webhook (Always Enabled)
```bash
curl -X POST https://your-locigram/api/webhook/ingest \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"content": "Manual note", "sourceType": "manual"}'
```

---

## Building an External Connector

External connectors are standalone processes that:
1. Receive a connector token from the admin
2. Pull data from their source on a schedule (or react to events)
3. Push memories to Locigram via the ingest API
4. Report sync status back to Locigram

Minimal example:

```typescript
const LOCIGRAM_URL = process.env.LOCIGRAM_URL       // e.g. https://your-locigram
const TOKEN = process.env.LOCIGRAM_CONNECTOR_TOKEN   // scoped connector token
const INSTANCE_ID = process.env.LOCIGRAM_INSTANCE_ID // connector instance UUID

// 1. Pull data from your source
const items = await fetchFromMySource(cursor)

// 2. Push each item to Locigram
for (const item of items) {
  await fetch(`${LOCIGRAM_URL}/api/ingest`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: item.summary,
      sourceType: 'my-source',
      sourceRef: item.id,
      occurredAt: item.timestamp,
    }),
  })
}

// 3. Report sync completion
await fetch(`${LOCIGRAM_URL}/api/connectors/${INSTANCE_ID}/sync`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({
    itemsPulled: items.length,
    cursorAfter: newCursor,
  }),
})
```

---

## Design Principles

1. **Connectors are additive feeders** — they only add/update, never delete. Locigram sweep owns memory lifecycle.
2. **Source attribution is mandatory** — every locigram traces back to its origin connector and source ID.
3. **Temporal context is first-class** — `occurredAt` enables "what did we know when?" queries.
4. **Multi-tenant isolation** — configs, tokens, and data are palace-scoped.
5. **Least privilege** — connector tokens can only access their own instance and ingest endpoint.
6. **Bundled = generic, External = specific** — keep the core image lean.
7. **Idempotent syncs** — re-running a sync produces the same result.
