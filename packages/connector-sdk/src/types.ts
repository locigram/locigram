export interface Memory {
  content: string
  sourceType: string
  sourceRef?: string
  occurredAt?: string   // ISO timestamp
  locus?: string
  importance?: 'low' | 'normal' | 'high'
  metadata?: Record<string, unknown>
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
