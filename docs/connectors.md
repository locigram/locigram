# Locigram — Connectors

Connectors pull from external sources and feed locigrams into your palace. They auto-register at startup based on available environment variables.

> **Noise filtering:** Every connector filters spam, automated messages, and low-content records before anything reaches the LLM.

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
グループ channel messages by reply thread. Groups are processed once quiet for 2 hours.
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

## Special Purpose Connectors

### Session Monitor (`@locigram/session-monitor`)
Watches OpenClaw agent session logs and generates handoff summaries.
*   `agent/{name}/session/{id}` — Individual summaries
*   `agent/{name}/context` — Live structured state
*   `agent/{name}/heartbeat` — Liveness signals

### secondbrain-sync
Nightly synthesis of SuruDB business data (clients, tickets, devices).
*   Locus: `connectors/secondbrain-sync`

### obsidian-audit & obsidian-sync
Daily vault evaluation (3am) and hourly summarized sync (:15).
*   Locus: `connectors/obsidian-sync`
*   Includes `Source: path/to/note.md` for full content retrieval.
*   **Additive only** — connectors never delete or downgrade memories. Locigram sweep owns lifecycle.
*   Audit safeguards: previously indexed notes cannot be downgraded; LLM failures preserve existing verdicts.

### Webhook (Always Enabled)
Push content directly via REST.
```bash
curl -X POST http://localhost:3000/api/webhook/ingest \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{ "content": "Manual note content", "sourceType": "manual" }'
```
