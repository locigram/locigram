import { z } from 'zod'
import type { ConnectorPlugin, RawMemory } from '@locigram/core'

// Schema for inbound webhook payloads
export const WebhookPayloadSchema = z.object({
  content:    z.string().min(1),
  sourceType: z.enum(['email', 'chat', 'sms', 'llm-session', 'manual', 'system', 'webhook'])
               .default('webhook'),
  sourceRef:  z.string().optional(),
  occurredAt: z.string().datetime().optional(),  // ISO string; defaults to now
  metadata:   z.record(z.unknown()).optional(),
})

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>

export interface WebhookConnectorConfig {
  secret?: string  // optional shared secret for verifying inbound calls
}

// Buffer for pull-based access — Hono route pushes here, pipeline pulls
const buffer: RawMemory[] = []

export function pushToBuffer(raw: RawMemory) {
  buffer.push(raw)
}

export const webhookConnector: ConnectorPlugin = {
  name: 'webhook',

  validate(config: unknown): config is WebhookConnectorConfig {
    return typeof config === 'object' && config !== null
  },

  async pull(_since?: Date): Promise<RawMemory[]> {
    // Drain buffer — return all queued memories since last pull
    return buffer.splice(0, buffer.length)
  },
}
