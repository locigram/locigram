import { z } from 'zod'
import type { ConnectorPlugin, RawMemory } from '@locigram/core'

// ── Webhook Payload Schema ────────────────────────────────────────────────────
// Supports three modes:
//   1. Raw content (string) — goes through full LLM extraction pipeline
//   2. Structured data (object) — skips LLM, uses pre-classified fields
//   3. Batch (array of either) — multiple memories in one POST

const SingleMemorySchema = z.object({
  // Content — the actual memory text
  content:    z.string().min(1),
  sourceType: z.enum([
    'email', 'chat', 'sms', 'llm-session', 'manual', 'system', 'webhook',
    'health', 'location', 'purchase', 'browsing', 'notification', 'iot',
  ]).default('webhook'),
  sourceRef:  z.string().optional(),
  occurredAt: z.string().datetime().optional(),

  // Routing
  locus:      z.string().optional(),     // e.g. "personal/health", "personal/location"
  connector:  z.string().optional(),     // override connector name in metadata

  // Pre-classification — skip LLM extraction when the source already has structure
  preClassified: z.object({
    category:        z.string().optional(),
    subject:         z.string().optional(),
    predicate:       z.string().optional(),
    objectVal:       z.string().optional(),
    entities:        z.array(z.string()).optional(),
    importance:      z.enum(['low', 'normal', 'high']).optional(),
    durabilityClass: z.string().optional(),
    isReference:     z.boolean().optional(),
  }).optional(),

  // Arbitrary metadata passed through to the pipeline
  metadata:   z.record(z.unknown()).optional(),
})

export const WebhookPayloadSchema = z.union([
  // Single memory
  SingleMemorySchema,
  // Batch of memories
  z.object({
    memories: z.array(SingleMemorySchema).min(1).max(100),
    // Shared defaults applied to all memories in the batch
    defaults: z.object({
      sourceType: z.string().optional(),
      locus:      z.string().optional(),
      connector:  z.string().optional(),
      metadata:   z.record(z.unknown()).optional(),
    }).optional(),
  }),
])

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>
export type SingleMemory = z.infer<typeof SingleMemorySchema>

export interface WebhookConnectorConfig {
  secret?: string       // optional shared secret for verifying inbound calls
  apiKeys?: string[]    // additional API keys for programmatic access
}

/**
 * Convert a webhook payload item into a RawMemory for the pipeline.
 */
export function toRawMemory(
  item: SingleMemory,
  palaceId: string,
  defaults?: { sourceType?: string; locus?: string; connector?: string; metadata?: Record<string, unknown> },
): RawMemory {
  const connectorName = item.connector ?? defaults?.connector ?? 'webhook'
  const locus = item.locus ?? defaults?.locus

  const raw: RawMemory = {
    content:    item.content,
    sourceType: (item.sourceType ?? defaults?.sourceType ?? 'webhook') as RawMemory['sourceType'],
    sourceRef:  item.sourceRef,
    occurredAt: item.occurredAt ? new Date(item.occurredAt) : new Date(),
    metadata: {
      ...defaults?.metadata,
      ...item.metadata,
      connector: connectorName,
      palace_id: palaceId,
    },
  }

  // If pre-classified or locus is provided, build the preClassified block
  if (item.preClassified || locus) {
    raw.preClassified = {
      locus:           locus ?? 'personal/general',
      entities:        item.preClassified?.entities ?? [],
      isReference:     item.preClassified?.isReference ?? false,
      importance:      (item.preClassified?.importance ?? 'normal') as 'low' | 'normal' | 'high',
      category:        item.preClassified?.category,
      subject:         item.preClassified?.subject,
      predicate:       item.preClassified?.predicate,
      objectVal:       item.preClassified?.objectVal,
      durabilityClass: item.preClassified?.durabilityClass ?? 'permanent',
    }
  }

  return raw
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
