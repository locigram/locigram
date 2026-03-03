// @locigram/core — shared types, interfaces, schemas
import { z } from 'zod'

// ── Locus (namespace) ────────────────────────────────────────────────────────

export type Locus =
  | `people/${string}`
  | `business/${string}`
  | `technical/${string}`
  | `personal/${string}`
  | `project/${string}`
  | `agent/${string}`

// ── Source Types ─────────────────────────────────────────────────────────────

export type SourceType =
  | 'email'
  | 'chat'
  | 'sms'
  | 'llm-session'
  | 'manual'
  | 'system'
  | 'webhook'

// ── Core Memory Types ─────────────────────────────────────────────────────────

export interface Locigram {
  id: string
  content: string
  sourceType: SourceType
  sourceRef?: string
  locus: Locus
  entities: string[]
  confidence: number       // 0.0–1.0
  metadata: Record<string, unknown>
  embeddingId?: string
  createdAt: Date
  expiresAt?: Date
  palaceId: string
}

export interface Truth {
  id: string
  statement: string
  locus: Locus
  entities: string[]
  confidence: number       // reinforced 0.0–1.0
  sourceCount: number
  lastSeen: Date
  createdAt: Date
  locigramIds: string[]
  palaceId: string
}

export interface Entity {
  id: string
  name: string
  type: 'person' | 'org' | 'product' | 'topic' | 'place'
  aliases: string[]
  metadata: Record<string, unknown>
  palaceId: string
  createdAt: Date
}

export interface Palace {
  id: string
  name: string
  ownerId: string
  createdAt: Date
}

// ── Connector Plugin System ───────────────────────────────────────────────────

export interface RawMemory {
  content: string
  sourceType: SourceType
  sourceRef?: string
  occurredAt: Date
  metadata?: Record<string, unknown>
}

export interface Connector {
  name: string
  pull(opts?: { since?: Date; limit?: number }): Promise<RawMemory[]>
  listen?(handler: (memory: RawMemory) => void): void
}

export interface ConnectorPlugin {
  name: string           // e.g. 'locigram-connector-notion'
  version: string
  configSchema: z.ZodSchema  // declares required config fields
  create(config: unknown): Connector
}
