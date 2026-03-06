import type { Memory, IngestResult, SyncReport, ConnectorInstance } from './types'

export interface LocigramClientConfig {
  url: string           // e.g. https://your-locigram.com
  token: string         // connector token (lc_...)
  instanceId: string    // connector instance UUID
  batchSize?: number    // max memories per ingest call (default 50, max 100)
  timeoutMs?: number    // request timeout (default 120000)
}

export class LocigramClient {
  private url: string
  private token: string
  private instanceId: string
  private batchSize: number
  private timeoutMs: number

  constructor(config: LocigramClientConfig) {
    this.url = config.url.replace(/\/$/, '')
    this.token = config.token
    this.instanceId = config.instanceId
    this.batchSize = Math.min(config.batchSize ?? 50, 100)
    this.timeoutMs = config.timeoutMs ?? 120_000

    if (!this.token) throw new Error('LOCIGRAM_CONNECTOR_TOKEN is required')
    if (!this.instanceId) throw new Error('LOCIGRAM_INSTANCE_ID is required')
    if (!this.url) throw new Error('LOCIGRAM_URL is required')
  }

  /**
   * Create a client from environment variables.
   * Reads: LOCIGRAM_URL, LOCIGRAM_CONNECTOR_TOKEN, LOCIGRAM_INSTANCE_ID
   */
  static fromEnv(): LocigramClient {
    return new LocigramClient({
      url: process.env.LOCIGRAM_URL ?? '',
      token: process.env.LOCIGRAM_CONNECTOR_TOKEN ?? '',
      instanceId: process.env.LOCIGRAM_INSTANCE_ID ?? '',
    })
  }

  /** Push memories to Locigram. Automatically batches if over batchSize. */
  async ingest(memories: Memory[]): Promise<IngestResult> {
    if (memories.length === 0) return { ingested: 0, skipped: 0 }

    const result: IngestResult = { ingested: 0, skipped: 0 }

    for (let i = 0; i < memories.length; i += this.batchSize) {
      const batch = memories.slice(i, i + this.batchSize)
      const res = await this.post(`/api/connectors/${this.instanceId}/ingest`, { memories: batch })
      result.ingested += res.ingested ?? 0
      result.skipped += res.skipped ?? 0
    }

    return result
  }

  /** Report sync results to Locigram. */
  async report(report: SyncReport): Promise<void> {
    await this.post(`/api/connectors/${this.instanceId}/report`, report)
  }

  /** Get current connector instance status. */
  async status(): Promise<ConnectorInstance> {
    return this.get(`/api/connectors/${this.instanceId}`)
  }

  /** Get the current cursor value. */
  async getCursor<T = unknown>(): Promise<T | null> {
    const instance = await this.status()
    return (instance.cursor as T) ?? null
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Locigram API error (${res.status}): ${text}`)
    }

    return res.json()
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.url}${path}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Locigram API error (${res.status}): ${text}`)
    }

    return res.json()
  }
}
