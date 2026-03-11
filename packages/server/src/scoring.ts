export interface ScoredResult {
  id: string
  text: string
  createdAt: Date | string
  _score: number
  [key: string]: unknown
}

export function applyLengthNormalization(
  results: ScoredResult[],
  anchor: number = 500,
): ScoredResult[] {
  if (anchor <= 0) return results
  return results.map(r => ({
    ...r,
    _score: r._score * (1 / (1 + 0.5 * Math.log2(Math.max(r.text.length, 1) / anchor))),
  }))
}

export function applyTimeDecay(
  results: ScoredResult[],
  halfLifeDays: number = 60,
): ScoredResult[] {
  if (halfLifeDays <= 0) return results
  const now = Date.now()
  return results.map(r => {
    const created = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime()
    const ageDays = (now - created) / (1000 * 60 * 60 * 24)
    const factor = 0.5 + 0.5 * Math.exp(-ageDays / halfLifeDays)
    return { ...r, _score: r._score * factor }
  })
}

function wordTrigrams(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0)
  const trigrams = new Set<string>()
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  }
  return trigrams
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  // Both empty = not comparable (prevents false-positive MMR penalties on short text)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Boost structured memories (those with SPO triples and high-value categories).
 * Decisions/conventions/preferences with SPO should rank above raw transcripts.
 */
export function applyStructuredBoost(
  results: ScoredResult[],
  spoBoost: number = 1.3,
  categoryBoost: Record<string, number> = {
    decision: 1.4,
    convention: 1.35,
    preference: 1.3,
    lesson: 1.25,
    checkpoint: 1.2,
    entity: 1.1,
    fact: 1.05,
    observation: 1.0,
  },
  durabilityBoost: Record<string, number> = {
    permanent: 1.15,
    stable: 1.1,
    active: 1.0,
    session: 0.9,
    checkpoint: 1.05,
  },
  importanceBoost: Record<string, number> = {
    high: 1.2,
    normal: 1.0,
    low: 0.85,
  },
): ScoredResult[] {
  return results.map(r => {
    let boost = 1.0

    // SPO boost: has subject AND predicate
    const hasSPO = !!(r as any).subject && !!(r as any).predicate
    if (hasSPO) boost *= spoBoost

    // Category boost
    const cat = (r as any).category as string
    if (cat && categoryBoost[cat]) boost *= categoryBoost[cat]

    // Durability boost
    const dur = (r as any).durabilityClass as string
    if (dur && durabilityBoost[dur]) boost *= durabilityBoost[dur]

    // Importance boost
    const imp = (r as any).importance as string
    if (imp && importanceBoost[imp]) boost *= importanceBoost[imp]

    return { ...r, _score: r._score * boost }
  })
}

export function applyMMRDiversity(
  results: ScoredResult[],
  similarityThreshold: number = 0.85,
  penaltyFactor: number = 0.5,
): ScoredResult[] {
  if (results.length <= 1) return results

  const sorted = [...results].sort((a, b) => b._score - a._score)
  const trigramCache = sorted.map(r => wordTrigrams(r.text))
  const selectedTrigrams: Set<string>[] = []
  const adjusted = sorted.map((r, i) => {
    let maxSim = 0
    for (const prev of selectedTrigrams) {
      const sim = jaccardSimilarity(trigramCache[i], prev)
      if (sim > maxSim) maxSim = sim
    }
    selectedTrigrams.push(trigramCache[i])
    const score = maxSim > similarityThreshold ? r._score * penaltyFactor : r._score
    return { ...r, _score: score }
  })

  return adjusted.sort((a, b) => b._score - a._score)
}
