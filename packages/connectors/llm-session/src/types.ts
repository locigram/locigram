export interface SessionMemory {
  sessionKey: string          // e.g. 'abc-123'
  sessionLabel: string        // human label (e.g. 'Locigram build session')
  summary: string             // LLM-generated handoff summary text
  messageCount: number
  durationMins?: number
  participants?: string[]     // user IDs or names
  occurredAt: Date            // session start or end time
  clientId?: string           // MSP client if applicable
}
