# Building a Locigram Connector Plugin

A connector plugin is a npm package that knows how to pull memories from a specific source and normalize them into `RawMemory` objects for Locigram's ingestion pipeline.

Anyone can build one. Publish it as `locigram-connector-*` on npm.

## Interface

```typescript
import { z } from 'zod'
import type { ConnectorPlugin, Connector, RawMemory } from '@locigram/core'

const myConnector: ConnectorPlugin = {
  name: 'locigram-connector-myapp',
  version: '1.0.0',

  // Declare what config your connector needs (Zod schema)
  configSchema: z.object({
    apiKey: z.string(),
    workspace: z.string().optional(),
  }),

  // Factory: receives validated config, returns a Connector
  create(config): Connector {
    return {
      name: 'locigram-connector-myapp',

      // Pull: return new memories since a given date
      async pull({ since, limit } = {}) {
        const items = await fetchFromMyApp({ since, limit, apiKey: config.apiKey })
        return items.map(item => ({
          content: item.text,
          sourceType: 'manual',
          sourceRef: item.id,
          occurredAt: new Date(item.createdAt),
          metadata: { workspace: item.workspace, author: item.author },
        } satisfies RawMemory))
      },

      // Optional: stream new memories in real-time
      listen(handler) {
        subscribeToMyApp(config.apiKey, (event) => {
          handler({
            content: event.text,
            sourceType: 'manual',
            sourceRef: event.id,
            occurredAt: new Date(),
          })
        })
      },
    }
  },
}

export default myConnector
```

## Registration

In the user's `locigram.config.ts`:

```typescript
import myConnector from 'locigram-connector-myapp'
import { registry } from '@locigram/registry'

registry.register(myConnector)

export default {
  connectors: [
    {
      plugin: 'locigram-connector-myapp',
      enabled: true,
      config: { apiKey: process.env.MYAPP_API_KEY },
    },
  ],
}
```

## Guidelines

- **Connectors don't store anything** — return `RawMemory[]`, pipeline handles the rest
- **Include a cursor** — track `since` so you only pull new data each run
- **Handle errors gracefully** — failed pulls should log and return `[]`, never throw
- **Declare all config in `configSchema`** — users get clear validation errors if something's missing
- **`metadata` is freeform JSONB** — include anything useful from the source (author, tags, thread ID, etc.)

## Naming Convention

`locigram-connector-<source>` — e.g.:
- `locigram-connector-notion`
- `locigram-connector-slack`
- `locigram-connector-hubspot`
- `locigram-connector-linear`
