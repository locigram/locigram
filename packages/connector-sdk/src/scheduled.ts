import { LocigramClient } from './client'
import type { Memory, IngestResult } from './types'

export interface ScheduledConnectorConfig {
  name: string
  /** Pull function: receives cursor, returns memories + new cursor */
  pull: (cursor: unknown | null) => Promise<{ memories: Memory[]; cursor?: unknown; hasMore?: boolean }>
  /** Optional: called on error */
  onError?: (error: Error) => void
  /** Locigram client (or creates from env) */
  client?: LocigramClient
}

export class ScheduledConnector {
  private config: ScheduledConnectorConfig
  private client: LocigramClient

  constructor(config: ScheduledConnectorConfig) {
    this.config = config
    this.client = config.client ?? LocigramClient.fromEnv()
  }

  /** Run one sync cycle: pull -> ingest -> report */
  async run(): Promise<IngestResult> {
    const startTime = Date.now()
    let totalResult: IngestResult = { ingested: 0, skipped: 0 }
    let pullError: string | undefined
    let itemsPulled = 0

    try {
      // Get current cursor
      const cursor = await this.client.getCursor()

      // Pull from source
      const { memories, cursor: newCursor } = await this.config.pull(cursor)
      itemsPulled = memories.length

      if (memories.length > 0) {
        // Ingest to Locigram
        totalResult = await this.client.ingest(memories)
      }

      // Report sync
      await this.client.report({
        itemsPulled,
        itemsPushed: totalResult.ingested,
        itemsSkipped: totalResult.skipped,
        durationMs: Date.now() - startTime,
        cursorAfter: newCursor,
      })

    } catch (error) {
      pullError = error instanceof Error ? error.message : String(error)
      this.config.onError?.(error instanceof Error ? error : new Error(pullError))

      // Report failure
      try {
        await this.client.report({
          itemsPulled,
          itemsPushed: totalResult.ingested,
          itemsSkipped: totalResult.skipped,
          durationMs: Date.now() - startTime,
          error: pullError,
        })
      } catch { /* best effort */ }
    }

    return totalResult
  }
}
