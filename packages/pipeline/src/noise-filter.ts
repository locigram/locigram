const DENIAL_PATTERNS = [
  /I don't have any (information|data|memory|record|memories)/i,
  /I have no (information|data|memory|record|memories)/i,
  /I don't recall/i,
  /I don't remember/i,
]

const META_PATTERNS = [
  /do you remember/i,
  /can you recall/i,
  /did I tell you/i,
]

const BOILERPLATE_PATTERNS = [
  /^(hi|hello|hey|good morning)\b/i,
  /^HEARTBEAT\b/,
  /^fresh session\b/i,
  // Session monitor noise: summarizer prompt echoes
  /^(The )?task is to summarize/i,
  /^(The )?session is being summarized/i,
  /^Summary must contain/i,
  /^(The )?immediate task is to/i,
  // CoT leaks from LLM summarizer
  /^Thinking Process:/i,
  /^\d+\.\s+\*\*Analyze/i,
  // Cron job execution logs (operational, not memorable)
  /^(A |The )?scheduled (cron|automated|local) (job|task)/i,
  /^(A |The )?(cron job|usage sync|health check) (was |has been )?(executed|completed|initiated|run)\b/i,
  // Agent metadata noise
  /^{"agentType":/,
  /^{"status":"(alive|ok)"/,
  // Return-only-JSON instruction echoes
  /must return ONLY raw JSON/i,
]

export function isNoise(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 5) return true
  for (const p of DENIAL_PATTERNS) { if (p.test(trimmed)) return true }
  for (const p of META_PATTERNS) { if (p.test(trimmed)) return true }
  for (const p of BOILERPLATE_PATTERNS) { if (p.test(trimmed)) return true }
  return false
}

export function filterNoise<T>(items: T[], getText: (item: T) => string): T[] {
  return items.filter(item => !isNoise(getText(item)))
}

/**
 * Post-extraction quality gate: downgrade mis-categorized locigrams.
 * The LLM extraction often over-promotes operational logs to 'decision' or 'fact'.
 * This catches common patterns and demotes them to 'observation' with lower confidence.
 */
const OPERATIONAL_NOISE_PATTERNS = [
  /^(A |The )?(cron job|scheduled job|usage sync|health check)\b/i,
  /\b(was executed|was initiated|was completed|ran successfully)\b/i,
  /^(The |A )?task is to (summarize|execute|run|automate)\b/i,
  /^(The |A )?session is (a |being )?(memory extraction|summariz)/i,
  /^(The |A )?(sync|synchronization) script\b/i,
  /^(The )?agent named '\w+' is executing/i,
]

export interface ExtractedLocigram {
  content: string
  confidence: number
  category: string
  subject: string | null
  predicate: string | null
  object_val: string | null
  durability_class: string
}

export function qualityGate(locigrams: ExtractedLocigram[]): ExtractedLocigram[] {
  return locigrams.map(loc => {
    // Only check high-value categories for mis-categorization
    if (!['decision', 'convention', 'preference', 'lesson'].includes(loc.category)) return loc

    const isOperationalNoise = OPERATIONAL_NOISE_PATTERNS.some(p => p.test(loc.content))
    if (isOperationalNoise) {
      return {
        ...loc,
        category: 'observation',
        durability_class: 'session',
        confidence: Math.min(loc.confidence, 0.4),
      }
    }

    return loc
  })
}
