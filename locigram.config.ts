import { createRegistry } from '@locigram/registry'
import { createHaloPSAConnector } from '@locigram/connector-halopsa'
import { createM365EmailConnector } from '@locigram/connector-m365-email'
import { createMemoryApiConnector } from '@locigram/connector-memory-api'
import { webhookConnector } from '@locigram/connector-webhook'

/**
 * Andrew's palace — locigram.config.ts
 *
 * Each connector is registered independently so they can be
 * tested, paused, or replaced without affecting the others.
 */

const SURU_DB_URL = process.env.SURU_DB_URL
  ?? 'postgresql://surubot:REDACTED_PASSWORD@YOUR_DB_HOST:5432/suru'

const MEMORY_API_URL   = process.env.MEMORY_API_URL   ?? 'http://YOUR_DB_HOST:3200'
const MEMORY_API_TOKEN = process.env.MEMORY_API_TOKEN ?? 'YOUR_API_TOKEN_HERE'

export const registry = createRegistry()

// ── Register connectors ───────────────────────────────────────────────────────

// 1. HaloPSA tickets from suru DB sync table
registry.register(createHaloPSAConnector({
  connectionString: SURU_DB_URL,
  limit: 200,
}))

// 2. M365 email from suru DB sync table
registry.register(createM365EmailConnector({
  connectionString: SURU_DB_URL,
  limit: 200,
  maxBodyChars: 1500,
}))

// 3. Observations + lessons from OpenClaw memory API
registry.register(createMemoryApiConnector({
  baseUrl: MEMORY_API_URL,
  token:   MEMORY_API_TOKEN,
  sources: ['observations', 'lessons'],
}))

// 4. Webhook — always on; enables manual memory push
registry.register(webhookConnector)

export default registry
