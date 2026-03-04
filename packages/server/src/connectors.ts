/**
 * Auto-register connectors based on env vars.
 * No config file needed — connectors light up when credentials are present.
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

  // ── HaloPSA (support tickets) ──────────────────────────────────────────────
  // Required: LOCIGRAM_HALOPSA_URL, LOCIGRAM_HALOPSA_CLIENT_ID, LOCIGRAM_HALOPSA_CLIENT_SECRET
  if (process.env.LOCIGRAM_HALOPSA_URL &&
      process.env.LOCIGRAM_HALOPSA_CLIENT_ID &&
      process.env.LOCIGRAM_HALOPSA_CLIENT_SECRET) {
    import('@locigram/connector-halopsa').then(({ createHaloPSAConnector }) => {
      registry.register(createHaloPSAConnector({
        baseUrl:      process.env.LOCIGRAM_HALOPSA_URL!,
        clientId:     process.env.LOCIGRAM_HALOPSA_CLIENT_ID!,
        clientSecret: process.env.LOCIGRAM_HALOPSA_CLIENT_SECRET!,
      }))
      console.log('[connectors] ✓ halopsa')
    }).catch(e => console.warn('[connectors] halopsa load failed:', e))
  }

  // ── NinjaOne (devices + alerts) ────────────────────────────────────────────
  // Required: LOCIGRAM_NINJA_CLIENT_ID, LOCIGRAM_NINJA_CLIENT_SECRET
  if (process.env.LOCIGRAM_NINJA_CLIENT_ID &&
      process.env.LOCIGRAM_NINJA_CLIENT_SECRET) {
    import('@locigram/connector-ninjaone').then(({ createNinjaOneConnector }) => {
      registry.register(createNinjaOneConnector({
        clientId:     process.env.LOCIGRAM_NINJA_CLIENT_ID!,
        clientSecret: process.env.LOCIGRAM_NINJA_CLIENT_SECRET!,
        sources:      ['devices', 'alerts'],
      }))
      console.log('[connectors] ✓ ninjaone')
    }).catch(e => console.warn('[connectors] ninjaone load failed:', e))
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

  // ── QuickBooks Online ─────────────────────────────────────────────────────
  // Required: LOCIGRAM_QBO_CLIENT_ID, LOCIGRAM_QBO_CLIENT_SECRET,
  //           LOCIGRAM_QBO_REALM_ID, LOCIGRAM_QBO_REFRESH_TOKEN
  if (process.env.LOCIGRAM_QBO_CLIENT_ID &&
      process.env.LOCIGRAM_QBO_CLIENT_SECRET &&
      process.env.LOCIGRAM_QBO_REALM_ID   &&
      process.env.LOCIGRAM_QBO_REFRESH_TOKEN) {
    import('@locigram/connector-qbo').then(({ qboPlugin }) => {
      registry.register(qboPlugin.create({
        clientId:     process.env.LOCIGRAM_QBO_CLIENT_ID!,
        clientSecret: process.env.LOCIGRAM_QBO_CLIENT_SECRET!,
        realmId:      process.env.LOCIGRAM_QBO_REALM_ID!,
        refreshToken: process.env.LOCIGRAM_QBO_REFRESH_TOKEN!,
        accessToken:  process.env.LOCIGRAM_QBO_ACCESS_TOKEN,
        baseUrl:      process.env.LOCIGRAM_QBO_BASE_URL,
        minorVersion: process.env.LOCIGRAM_QBO_MINOR_VERSION,
      }))
      console.log('[connectors] ✓ qbo')
    }).catch(e => console.warn('[connectors] qbo load failed:', e))
  }

  return registry
}
