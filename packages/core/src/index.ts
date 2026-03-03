// Locigram Core Types

export type Locus =
  | `people/${string}`
  | `business/${string}`
  | `technical/${string}`
  | `personal/${string}`
  | `project/${string}`
  | `agent/${string}`

export type SourceType =
  | 'email'
  | 'chat'
  | 'sms'
  | 'llm-session'
  | 'manual'
  | 'system'
  | 'webhook'

export interface Locigram {
  id: string
  content: string
  sourceType: SourceType
  sourceRef?: string
  locus: Locus
  entities: string[]
  confidence: number         // 0.0–1.0
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
  confidence: number         // reinforced score 0.0–1.0
  sourceCount: number        // number of locigrams backing this
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
  palaceId: string
  createdAt: Date
}

export interface Palace {
  id: string
  name: string
  ownerId: string
  createdAt: Date
}

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
