import type { ConnectorPlugin, RawMemory } from '@locigram/core'
import type { SessionMemory } from './types'

/** Minimum word count — summaries shorter than this are skipped */
export const MIN_WORDS = 50

/**
 * Convert an LLM session into a RawMemory for ingestion.
 * Returns null if the summary is too short (< MIN_WORDS).
 */
export function formatSession(session: SessionMemory): RawMemory | null {
  const wordCount = session.summary.trim().split(/\s+/).length
  if (wordCount < MIN_WORDS) return null

  return {
    content: session.summary,
    sourceType: 'llm-session',
    sourceRef: `openclaw:session:${session.sessionKey}`,
    occurredAt: session.occurredAt,
    metadata: {
      session_key: session.sessionKey,
      session_label: session.sessionLabel,
      message_count: session.messageCount,
      duration_mins: session.durationMins,
      participants: session.participants,
    },
    preClassified: {
      locus: 'agent/openclaw',
      entities: [],
      isReference: false,
      importance: 'normal',
      clientId: session.clientId ?? undefined,
    },
  }
}

/** Push-only connector — data is pushed via formatSession() */
export const plugin: ConnectorPlugin = {
  name: 'llm-session',

  validate(config: unknown): config is Record<string, unknown> {
    return typeof config === 'object' && config !== null
  },

  async pull(): Promise<RawMemory[]> {
    return [] // push-only — no pull
  },
}
