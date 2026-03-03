// locigram.config.ts — palace configuration + connector registration
// Copy this file and edit for your palace.

import type { ConnectorConfig } from '@locigram/registry'

export default {
  palace: {
    id: process.env.PALACE_ID ?? 'default',
    name: process.env.PALACE_NAME ?? 'My Palace',
  },

  server: {
    port: Number(process.env.PORT ?? 3000),
    apiToken: process.env.API_TOKEN,  // bearer token for REST + MCP
  },

  db: {
    url: process.env.DATABASE_URL!,
  },

  qdrant: {
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    collection: process.env.QDRANT_COLLECTION ?? 'locigrams',
  },

  // Connectors: built-in or third-party plugins
  // Third-party: npm install locigram-connector-notion → add entry below
  connectors: [
    // Built-in connectors (disabled by default — enable + configure as needed)
    {
      plugin: '@locigram/connector-webhook',
      enabled: true,
      config: {},
    },
    {
      plugin: '@locigram/connector-email',
      enabled: false,
      config: {
        // tenant: process.env.M365_TENANT_ID,
        // clientId: process.env.M365_CLIENT_ID,
      },
    },
    {
      plugin: '@locigram/connector-sms',
      enabled: false,
      config: {
        // accountSid: process.env.TWILIO_ACCOUNT_SID,
        // authToken: process.env.TWILIO_AUTH_TOKEN,
      },
    },
    // Example third-party connector:
    // {
    //   plugin: 'locigram-connector-notion',
    //   enabled: true,
    //   config: { token: process.env.NOTION_TOKEN, databaseId: '...' },
    // },
  ] satisfies ConnectorConfig[],
}
