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
