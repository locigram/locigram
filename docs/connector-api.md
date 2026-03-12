# Building a Locigram Connector

A connector feeds data from an external source into Locigram's memory pipeline.
There are three ingestion patterns — pick the one that fits your data source.

## Ingestion Patterns

### 1. Webhook (simplest — no server code needed)

POST data directly to the Locigram server. Best for: iOS Shortcuts, Zapier,
n8n, cron scripts, IoT devices, anything that can make HTTP calls.

```bash
# Single memory — goes through full LLM extraction pipeline
curl -X POST https://locigram.example/api/webhook/ingest \
  -H "Authorization: Bearer $PALACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Walked 11,200 steps today. Resting HR 62bpm. Slept 7.1 hours.",
    "sourceType": "health",
    "locus": "personal/health"
  }'

# Pre-classified — skip LLM extraction when you already have structure
curl -X POST https://locigram.example/api/webhook/health \
  -H "Authorization: Bearer $PALACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Daily health: 11,200 steps, 7.1h sleep, 62bpm resting HR",
    "preClassified": {
      "subject": "Andrew",
      "predicate": "daily_health",
      "objectVal": "11200 steps, 7.1h sleep, 62bpm HR",
      "entities": ["Andrew"],
      "importance": "normal",
      "durabilityClass": "permanent"
    }
  }'

# Batch — up to 100 memories in one POST
curl -X POST https://locigram.example/api/webhook/ingest \
  -H "Authorization: Bearer $PALACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "memories": [
      {"content": "Visited reddit.com/r/homelab for 8 minutes"},
      {"content": "Searched Amazon for USB-C hub"},
      {"content": "Read Hacker News article about K3s networking"}
    ],
    "defaults": {
      "sourceType": "browsing",
      "locus": "personal/browsing",
      "connector": "browser-history"
    }
  }'
```

**Typed convenience endpoints** (auto-set locus + sourceType):

| Endpoint | Locus | Source Type | Use For |
|----------|-------|------------|---------|
| `POST /api/webhook/ingest` | (you set it) | (you set it) | Generic |
| `POST /api/webhook/push` | (you set it) | (you set it) | Queue (no immediate ingest) |
| `POST /api/webhook/health` | `personal/health` | `health` | Apple Health, Fitbit, wearables |
| `POST /api/webhook/location` | `personal/location` | `location` | GPS, geofence, check-ins |
| `POST /api/webhook/browsing` | `personal/browsing` | `browsing` | Browser history, bookmarks |

**Auth options:**
- `Authorization: Bearer <palace_token>` (same token as other API calls)
- `x-webhook-secret: <secret>` (env: `WEBHOOK_SECRET`)
- `x-api-key: <key>` (env: `WEBHOOK_API_KEYS`, comma-separated)

### 2. External Connector (daemon or cron, pushes via API)

A standalone process that pulls from a source and pushes memories to Locigram.
Best for: email sync, Teams/Slack, CRM, accounting software, databases.

```bash
# Register a connector instance (one-time, returns a scoped token)
curl -X POST https://locigram.example/api/connectors \
  -H "Authorization: Bearer $PALACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "connectorType": "apple-health",
    "name": "Andrew Health Sync",
    "distribution": "external",
    "config": {}
  }'
# Returns: { "id": "uuid", "token": "lc_abc123..." }

# Push memories (use the connector token)
curl -X POST https://locigram.example/api/connectors/$INSTANCE_ID/ingest \
  -H "Authorization: Bearer $CONNECTOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "memories": [{
      "content": "Steps: 11,200. Sleep: 7.1h. HR: 62bpm.",
      "sourceType": "health",
      "sourceRef": "health:2026-03-12",
      "occurredAt": "2026-03-12T23:59:00Z",
      "locus": "personal/health",
      "importance": "normal",
      "subject": "Andrew",
      "predicate": "daily_health",
      "object_val": "11200 steps, 7.1h sleep, 62bpm",
      "durability_class": "permanent",
      "category": "observation"
    }]
  }'

# Report sync results (for tracking in admin panel)
curl -X POST https://locigram.example/api/connectors/$INSTANCE_ID/report \
  -H "Authorization: Bearer $CONNECTOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"itemsPulled": 1, "itemsPushed": 1, "itemsSkipped": 0}'
```

### 3. Bundled Connector Plugin (npm package, runs inside Locigram)

For connectors that need to run inside the Locigram server process.
Publish as `locigram-connector-<name>` on npm.

```typescript
import { z } from 'zod'
import type { ConnectorPlugin, Connector, RawMemory, PullResult } from '@locigram/core'

const healthConnector: ConnectorPlugin = {
  name: 'locigram-connector-health',
  version: '1.0.0',

  configSchema: z.object({
    exportPath: z.string().describe('Path to Apple Health export.xml'),
  }),

  create(config): Connector {
    return {
      name: 'locigram-connector-health',

      async pull({ since, cursor } = {}): Promise<PullResult> {
        const records = await parseHealthExport(config.exportPath, { since, cursor })

        return {
          memories: records.map(r => ({
            content: `${r.type}: ${r.value} ${r.unit} on ${r.date}`,
            sourceType: 'health',
            sourceRef: `health:${r.id}`,
            occurredAt: new Date(r.date),
            metadata: { type: r.type, value: r.value, unit: r.unit },

            // Pre-classification — structured data skips LLM extraction
            preClassified: {
              locus: 'personal/health',
              entities: ['Andrew'],
              isReference: false,
              importance: 'normal',
              category: 'observation',
              subject: 'Andrew',
              predicate: r.type,       // e.g. "daily_steps", "sleep_hours"
              objectVal: `${r.value} ${r.unit}`,
              durabilityClass: 'permanent',
            },
          } satisfies RawMemory)),
          cursor: records.at(-1)?.id,
          hasMore: records.length >= 100,
        }
      },
    }
  },
}

export default healthConnector
```

## RawMemory Interface

Every connector produces `RawMemory` objects. The pipeline handles everything else.

```typescript
interface RawMemory {
  content:    string       // The actual memory text
  sourceType: SourceType   // Where it came from
  sourceRef?: string       // Unique ID in the source system (for dedup)
  occurredAt?: Date        // When the event happened (defaults to now)
  metadata?:  Record<string, unknown>  // Freeform JSONB — connector name, tags, etc.

  // Pre-classification — set when the connector already has structured data.
  // When present, the pipeline SKIPS LLM extraction and uses these values directly.
  preClassified?: {
    locus:           string              // Memory namespace (e.g. "personal/health")
    entities:        string[]            // Resolved entity names
    isReference:     boolean             // Is this a reference document?
    referenceType?:  string              // "contract", "sla", etc.
    importance?:     'low' | 'normal' | 'high'
    clientId?:       string              // Client association
    clusterCandidate?: boolean           // Group related items via cluster worker

    // SPO triple — Subject-Predicate-Object structured facts
    category?:        string             // decision, fact, observation, etc.
    subject?:         string             // Who/what (e.g. "Andrew")
    predicate?:       string             // Relationship (e.g. "daily_steps")
    objectVal?:       string             // Value (e.g. "11,200")
    durabilityClass?: string             // permanent, stable, active, session, checkpoint
  }
}
```

## Source Types

```typescript
type SourceType =
  // Communication
  | 'email' | 'chat' | 'sms' | 'call'
  // Operational
  | 'ticket' | 'device' | 'calendar' | 'contact'
  | 'invoice' | 'payment' | 'bill' | 'vendor-payment'
  | 'timesheet' | 'contract'
  // AI / Session
  | 'llm-session' | 'note'
  // Personal
  | 'health' | 'location' | 'purchase' | 'browsing'
  | 'notification' | 'iot'
  // System
  | 'manual' | 'webhook' | 'system' | 'enrichment'
```

## Pipeline Processing

When a `RawMemory` enters the pipeline, it goes through:

1. **Noise filter** — rejects boilerplate, heartbeats, CoT leaks
2. **LLM extraction** (skipped if `preClassified`) — category, locus, entities, SPO triple, importance
3. **GLiNER entity detection** — NER model detects people, orgs, products, locations, topics
4. **Entity resolution** — matches detected entities to canonical entities (exact + alias match)
5. **Entity mention storage** — evidence trail with confidence scores
6. **Postgres insert** — full record with all structured fields
7. **Embed worker** (async, ~30s) — vectorizes content into Qdrant for semantic search
8. **Graph worker** (async, ~30s) — writes Memory→Entity edges to Memgraph

### When to use `preClassified`

| Scenario | Use preClassified? | Why |
|----------|-------------------|-----|
| Apple Health daily summary | ✅ Yes | Data is already structured (steps, HR, sleep) |
| GPS coordinates | ✅ Yes | Lat/lng + address = structured |
| Bank transactions | ✅ Yes | Amount, merchant, date = structured |
| Browser history URLs | ❌ No | Let LLM extract what the page is about |
| Email body text | ❌ No | Let LLM extract decisions, action items |
| Chat transcript | ❌ No | Let LLM extract topics and entities |
| Device inventory | ✅ Yes | Serial, model, specs = structured |

**Rule of thumb:** If the source data is already a fact with clear subject/predicate/object,
use `preClassified`. If it's unstructured text that needs interpretation, let the LLM handle it.

### Durability Classes

| Class | Meaning | Decay? | Use For |
|-------|---------|--------|---------|
| `permanent` | Never decays | No | Health records, financial data, identity facts |
| `stable` | Very slow decay | Minimal | Preferences, relationships, learned patterns |
| `active` | Normal decay | Yes | Current projects, recent conversations |
| `session` | Fast decay | Yes | Ephemeral observations, transient state |
| `checkpoint` | Agent state | Yes | Compaction summaries, handoff state |

### Entity Detection (GLiNER)

The pipeline runs GLiNER NER on all ingested content, even pre-classified.
Detected entity types: `person`, `organization`, `location`, `product`, `software`,
`ip_address`, `date`, `event`, `topic`.

Mentions are stored in `entity_mentions` with:
- `confidence` score (0.0–1.0, floor 0.5 for storage)
- `source` (gliner or llm)
- `span_start`/`span_end` character positions

Entity type enforcement uses majority vote: `count(type) × avg(confidence)` per source.

## Guidelines

- **Connectors don't store anything** — return `RawMemory[]`, the pipeline handles storage
- **Use `sourceRef` for dedup** — include a stable ID from the source system
- **Include `occurredAt`** — when the event *actually happened*, not when you ingested it
- **Use appropriate `durabilityClass`** — health/financial data = permanent, chat = active
- **Set `locus` for routing** — memories are scoped by locus in recall queries
- **Batch when possible** — up to 100 memories per POST, reduces API calls
- **Handle errors gracefully** — failed pulls should return `[]`, never throw

## Naming Convention

`locigram-connector-<source>` — e.g.:
- `locigram-connector-health` — Apple Health, Fitbit
- `locigram-connector-browser` — Chrome/Firefox history
- `locigram-connector-plaid` — Bank transactions
- `locigram-connector-location` — GPS tracking
