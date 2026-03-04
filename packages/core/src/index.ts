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
  // Communication
  | 'email'          // email messages (M365, Gmail)
  | 'chat'           // Teams, Slack, Discord messages
  | 'sms'            // SMS / text messages
  | 'call'           // phone call transcripts or summaries
  // Operational
  | 'ticket'         // support tickets (HaloPSA, Zendesk, Jira)
  | 'device'         // device inventory / alerts (NinjaOne)
  | 'calendar'       // calendar events and meetings
  | 'contact'        // contact records (CRM, M365 contacts)
  | 'invoice'        // billing / financial records
  | 'contract'       // contracts, SLAs, agreements
  // AI / Session
  | 'llm-session'    // extracted from AI conversation sessions
  | 'note'           // manual notes / observations
  // System
  | 'manual'         // manually pushed via webhook
  | 'webhook'        // raw webhook push (sourceType not specified)
  | 'system'         // system-generated (e.g. truth engine, bootstrap)

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
  content:    string
  sourceType: SourceType
  sourceRef?: string
  occurredAt?: Date           // when the event happened in the source system (optional — manual/webhook may not have it)
  metadata?:  Record<string, unknown>
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
