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
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
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
