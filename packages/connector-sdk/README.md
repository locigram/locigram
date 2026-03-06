# @locigram/connector-sdk

SDK for building external Locigram connectors in TypeScript.

## Install

```bash
bun add @locigram/connector-sdk
# or
npm install @locigram/connector-sdk
```

## Quick Start

```typescript
import { ScheduledConnector } from '@locigram/connector-sdk'

const connector = new ScheduledConnector({
  name: 'my-connector',
  async pull(cursor) {
    const items = await fetchFromMySource(cursor)
    return {
      memories: items.map(item => ({
        content: item.text,
        sourceType: 'my-source',
        sourceRef: item.id,
        occurredAt: item.timestamp,
      })),
      cursor: items[items.length - 1]?.id,
    }
  },
})

await connector.run()
```

Set these environment variables:
- `LOCIGRAM_URL` — Your Locigram server URL
- `LOCIGRAM_CONNECTOR_TOKEN` — Scoped connector token (`lc_...`)
- `LOCIGRAM_INSTANCE_ID` — Connector instance UUID

## Low-Level Client

```typescript
import { LocigramClient } from '@locigram/connector-sdk'

const client = LocigramClient.fromEnv()

// Push memories
await client.ingest([
  { content: 'Something happened', sourceType: 'event', sourceRef: 'evt-123' },
])

// Report sync
await client.report({ itemsPulled: 10, itemsPushed: 8, itemsSkipped: 2 })

// Check status
const status = await client.status()
console.log(status.itemsSynced, status.lastSyncAt)
```
