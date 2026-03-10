export interface SignalMatch {
  pattern: string
  category: string
  confidence: number
}

interface PatternDef {
  regex: RegExp
  pattern: string
  category: string
  confidence: number
}

const PATTERNS: PatternDef[] = [
  // Decision signals
  { regex: /\bwe decided\b/i, pattern: 'we decided', category: 'decision', confidence: 0.9 },
  { regex: /\bdecision is\b/i, pattern: 'decision is', category: 'decision', confidence: 0.9 },
  { regex: /\bgoing with\b/i, pattern: 'going with', category: 'decision', confidence: 0.7 },
  { regex: /\bapproved\b/i, pattern: 'approved', category: 'decision', confidence: 0.8 },
  { regex: /\blet'?s go with\b/i, pattern: "let's go with", category: 'decision', confidence: 0.8 },
  { regex: /\bchosen\b/i, pattern: 'chosen', category: 'decision', confidence: 0.7 },
  { regex: /\bpicked\b/i, pattern: 'picked', category: 'decision', confidence: 0.6 },
  { regex: /\bthe plan is\b/i, pattern: 'the plan is', category: 'decision', confidence: 0.8 },
  { regex: /\bwe'?re doing\b/i, pattern: "we're doing", category: 'decision', confidence: 0.7 },
  { regex: /\bswitching to\b/i, pattern: 'switching to', category: 'decision', confidence: 0.8 },
  { regex: /\bmoving to\b/i, pattern: 'moving to', category: 'decision', confidence: 0.7 },
  { regex: /\bagreed on\b/i, pattern: 'agreed on', category: 'decision', confidence: 0.9 },

  // Preference signals
  { regex: /\bfrom now on\b/i, pattern: 'from now on', category: 'preference', confidence: 0.9 },
  { regex: /\balways use\b/i, pattern: 'always use', category: 'preference', confidence: 0.9 },
  { regex: /\bnever use\b/i, pattern: 'never use', category: 'preference', confidence: 0.9 },
  { regex: /\bi prefer\b/i, pattern: 'I prefer', category: 'preference', confidence: 0.8 },
  { regex: /\bdefault to\b/i, pattern: 'default to', category: 'preference', confidence: 0.8 },
  { regex: /\bdon'?t ever\b/i, pattern: "don't ever", category: 'preference', confidence: 0.9 },
  { regex: /\brule:/i, pattern: 'rule:', category: 'preference', confidence: 0.8 },
  { regex: /\bpolicy:/i, pattern: 'policy:', category: 'preference', confidence: 0.8 },
  { regex: /\bstandard is\b/i, pattern: 'standard is', category: 'preference', confidence: 0.7 },
  { regex: /\bconvention is\b/i, pattern: 'convention is', category: 'preference', confidence: 0.8 },

  // Fact signals
  { regex: /\bthe password is\b/i, pattern: 'the password is', category: 'fact', confidence: 0.9 },
  { regex: /\bthe IP is\b/i, pattern: 'the IP is', category: 'fact', confidence: 0.9 },
  { regex: /\bcosts? \$/i, pattern: 'costs $', category: 'fact', confidence: 0.8 },
  { regex: /\bthe port is\b/i, pattern: 'the port is', category: 'fact', confidence: 0.9 },
  { regex: /\bthe URL is\b/i, pattern: 'the URL is', category: 'fact', confidence: 0.9 },
  { regex: /\bthe API key\b/i, pattern: 'the API key', category: 'fact', confidence: 0.9 },
  { regex: /\bthe token is\b/i, pattern: 'the token is', category: 'fact', confidence: 0.9 },
  { regex: /\blocated at\b/i, pattern: 'located at', category: 'fact', confidence: 0.7 },
  { regex: /\bruns on\b/i, pattern: 'runs on', category: 'fact', confidence: 0.7 },
  { regex: /\bversion is\b/i, pattern: 'version is', category: 'fact', confidence: 0.8 },
  { regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, pattern: 'IP address', category: 'fact', confidence: 0.7 },
  { regex: /https?:\/\/\S+/, pattern: 'URL', category: 'fact', confidence: 0.6 },

  // Lesson signals
  { regex: /\blesson learned\b/i, pattern: 'lesson learned', category: 'lesson', confidence: 0.9 },
  { regex: /\bwe learned\b/i, pattern: 'we learned', category: 'lesson', confidence: 0.8 },
  { regex: /\bnext time\b/i, pattern: 'next time', category: 'lesson', confidence: 0.7 },
  { regex: /\bmistake was\b/i, pattern: 'mistake was', category: 'lesson', confidence: 0.9 },
  { regex: /\bnote to self\b/i, pattern: 'note to self', category: 'lesson', confidence: 0.9 },
  { regex: /\bdon'?t forget\b/i, pattern: "don't forget", category: 'lesson', confidence: 0.8 },
  { regex: /\bimportant:/i, pattern: 'important:', category: 'lesson', confidence: 0.8 },
  { regex: /\bgotcha:/i, pattern: 'gotcha:', category: 'lesson', confidence: 0.9 },
  { regex: /\bcaveat:/i, pattern: 'caveat:', category: 'lesson', confidence: 0.9 },
  { regex: /\bwatch out for\b/i, pattern: 'watch out for', category: 'lesson', confidence: 0.8 },

  // Entity signals
  { regex: /\bis a person\b/i, pattern: 'is a person', category: 'entity', confidence: 0.9 },
  { regex: /\bworks at\b/i, pattern: 'works at', category: 'entity', confidence: 0.8 },
  { regex: /\bis responsible for\b/i, pattern: 'is responsible for', category: 'entity', confidence: 0.8 },
  { regex: /\btheir role is\b/i, pattern: 'their role is', category: 'entity', confidence: 0.8 },
]

export function detectHighSignal(text: string): SignalMatch | null {
  if (!text || text.length < 10) return null

  for (const def of PATTERNS) {
    if (def.regex.test(text)) {
      return { pattern: def.pattern, category: def.category, confidence: def.confidence }
    }
  }

  return null
}
