export interface Memory {
  content: string
  sourceType: string
  sourceRef?: string
  occurredAt?: string   // ISO timestamp
  locus?: string
  importance?: 'low' | 'normal' | 'high'
  metadata?: Record<string, unknown>

  // Structured fields (Phase 2.6) — optional, extracted by pipeline if not set
  subject?:         string  // Entity this fact is about
  predicate?:       string  // Attribute or relationship
  object_val?:      string  // The value
  durability_class?: 'permanent' | 'stable' | 'active' | 'session' | 'checkpoint'
}

export interface IngestResult {
  ingested: number
  skipped: number
}

export interface SyncReport {
  itemsPulled: number
  itemsPushed: number
  itemsSkipped: number
  durationMs?: number
  cursorAfter?: unknown
  error?: string
}

export interface ConnectorInstance {
  id: string
  palaceId: string
  connectorType: string
  name: string
  distribution: string
  status: string
  cursor: unknown
  lastSyncAt: string | null
  lastError: string | null
  itemsSynced: number
}
