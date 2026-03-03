import { createRegistry } from '@locigram/registry'
import { createMicrosoft365Connector } from '@locigram/connector-microsoft365'
import { createHaloPSAConnector } from '@locigram/connector-halopsa'
import { createNinjaOneConnector } from '@locigram/connector-ninjaone'
import { webhookConnector } from '@locigram/connector-webhook'
// import { createGmailConnector } from '@locigram/connector-gmail'  // if needed

export const registry = createRegistry()

// ── Microsoft 365 — email + Teams ────────────────────────────────────────────
registry.register(createMicrosoft365Connector({
  tenantId:     process.env.M365_TENANT_ID!,
  clientId:     process.env.M365_CLIENT_ID!,
  clientSecret: process.env.M365_CLIENT_SECRET!,
  mailboxes:    (process.env.M365_MAILBOXES ?? '').split(',').filter(Boolean),
  teamsChannels: [],  // add { teamId, channelId, label } entries as needed
}))

// ── HaloPSA — support tickets ─────────────────────────────────────────────────
registry.register(createHaloPSAConnector({
  baseUrl:      process.env.HALOPSA_BASE_URL!,
  clientId:     process.env.HALOPSA_CLIENT_ID!,
  clientSecret: process.env.HALOPSA_CLIENT_SECRET!,
}))

// ── NinjaOne — devices + alerts ───────────────────────────────────────────────
registry.register(createNinjaOneConnector({
  clientId:     process.env.NINJAONE_CLIENT_ID!,
  clientSecret: process.env.NINJAONE_CLIENT_SECRET!,
  sources:      ['devices', 'alerts'],
}))

// ── Webhook — manual memory push (always on) ──────────────────────────────────
registry.register(webhookConnector)

export default registry
