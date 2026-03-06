/**
 * Auto-register connectors based on env vars.
 * No config file needed — connectors light up when credentials are present.
 *
 * Only bundled (platform-level) connectors are registered here.
 * User-specific connectors (HaloPSA, NinjaOne, QBO) run externally
 * and authenticate via connector tokens.
 */
import { registry } from '@locigram/registry'
import { webhookConnector } from '@locigram/connector-webhook'
import type { DB } from '@locigram/db'

export function autoRegisterConnectors(opts?: { db?: DB; palaceId?: string }) {

  // Webhook is always on — zero config needed
  registry.register(webhookConnector)

  // ── Microsoft 365 (email + Teams) ─────────────────────────────────────────
  // Required: LOCIGRAM_M365_TENANT_ID, LOCIGRAM_M365_CLIENT_ID, LOCIGRAM_M365_CLIENT_SECRET
  if (process.env.LOCIGRAM_M365_TENANT_ID &&
      process.env.LOCIGRAM_M365_CLIENT_ID &&
      process.env.LOCIGRAM_M365_CLIENT_SECRET) {
    import('@locigram/connector-microsoft365').then(({ createMicrosoft365Connector }) => {
      registry.register(createMicrosoft365Connector({
        tenantId:     process.env.LOCIGRAM_M365_TENANT_ID!,
        clientId:     process.env.LOCIGRAM_M365_CLIENT_ID!,
        clientSecret: process.env.LOCIGRAM_M365_CLIENT_SECRET!,
        mailboxes:    (process.env.LOCIGRAM_M365_MAILBOXES ?? '').split(',').filter(Boolean),
        teamsChannels: [],
        db:           opts?.db,
        palaceId:     opts?.palaceId,
      }))
      console.log('[connectors] ✓ microsoft365')
    }).catch(e => console.warn('[connectors] microsoft365 load failed:', e))
  }

  // ── Gmail ──────────────────────────────────────────────────────────────────
  // Required: LOCIGRAM_GMAIL_CLIENT_ID, LOCIGRAM_GMAIL_CLIENT_SECRET, LOCIGRAM_GMAIL_REFRESH_TOKEN
  if (process.env.LOCIGRAM_GMAIL_CLIENT_ID &&
      process.env.LOCIGRAM_GMAIL_CLIENT_SECRET &&
      process.env.LOCIGRAM_GMAIL_REFRESH_TOKEN) {
    import('@locigram/connector-gmail').then(({ createGmailConnector }) => {
      registry.register(createGmailConnector({
        clientId:     process.env.LOCIGRAM_GMAIL_CLIENT_ID!,
        clientSecret: process.env.LOCIGRAM_GMAIL_CLIENT_SECRET!,
        refreshToken: process.env.LOCIGRAM_GMAIL_REFRESH_TOKEN!,
      }))
      console.log('[connectors] ✓ gmail')
    }).catch(e => console.warn('[connectors] gmail load failed:', e))
  }

  return registry
}
