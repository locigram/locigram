import { config } from './config'
import { pushToLocigram } from './ingest'
import { detectHighSignal, type SignalMatch } from './signal-detect'

export interface Exchange {
  userText: string
  assistantText: string
  timestamp: Date
}

// Debounce: don't push the same content twice within a window
const recentPushes = new Map<string, number>()

function simpleHash(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  }
  return String(hash)
}

function pruneRecentPushes(): void {
  const cutoff = Date.now() - config.perTurnDedupMs
  for (const [key, ts] of recentPushes) {
    if (ts < cutoff) recentPushes.delete(key)
  }
}

export async function maybeCaptureTurn(
  exchange: Exchange,
  agentName: string,
  sessionId: string,
): Promise<boolean> {
  if (!config.perTurnCapture) return false

  const signal = detectHighSignal(exchange.assistantText)
  if (!signal) return false

  const hash = simpleHash(exchange.userText + exchange.assistantText)

  // Prune old entries periodically
  pruneRecentPushes()

  const lastPush = recentPushes.get(hash)
  if (lastPush && (Date.now() - lastPush) < config.perTurnDedupMs) return false

  const content = `[user]: ${exchange.userText}\n[assistant]: ${exchange.assistantText}`
  const locus = `agent/${agentName}/realtime/${sessionId}`

  await pushToLocigram(agentName, sessionId, content, exchange.timestamp, locus)
  recentPushes.set(hash, Date.now())

  console.log(`[session-monitor] per-turn capture: ${signal.pattern} → pushed (${signal.category} signal)`)
  return true
}

// Exported for testing
export { recentPushes as _recentPushes }
