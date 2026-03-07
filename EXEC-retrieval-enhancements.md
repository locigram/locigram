# EXEC Plan: Retrieval Enhancements

## Objective
Add 4 post-Qdrant scoring modifiers to the recall pipeline and an access-reinforcement modifier to the sweep worker. All changes are additive — no existing behavior changes unless the new env vars are set.

## Shared Contract
- **Language:** TypeScript (Bun runtime)
- **No new dependencies** — all math is native JS
- **Env var gated:** Every feature disabled when its env var is unset or 0
- **All scoring happens in recall route, post-Qdrant, before response**
- **DO NOT modify Qdrant search or embedding logic**
- **DO NOT modify the access_count increment or retrieval_events insert**
- **Tests:** Add a new file `packages/server/src/routes/__tests__/scoring.test.ts` with unit tests for all scoring functions

---

## Task 1: Scoring utility module

**File:** `packages/server/src/scoring.ts` (NEW)

Create a module exporting pure scoring functions. All functions take a result array and return a re-scored copy.

### 1a: Length Normalization
```typescript
export function applyLengthNormalization(
  results: ScoredResult[],
  anchor: number = 500,  // env: LOCIGRAM_LENGTH_NORM_ANCHOR
): ScoredResult[]
```
Formula: `score *= 1 / (1 + 0.5 * Math.log2(Math.max(text.length, 1) / anchor))`
- `text` = the locigram's `text` field (from Postgres row)
- If `anchor <= 0`, return results unchanged (disabled)
- Entries shorter than anchor get a slight boost (factor > 1), longer get penalized

### 1b: Query-time Time Decay
```typescript
export function applyTimeDecay(
  results: ScoredResult[],
  halfLifeDays: number = 60,  // env: LOCIGRAM_QUERY_TIME_DECAY_HALFLIFE
): ScoredResult[]
```
Formula: `score *= 0.5 + 0.5 * Math.exp(-ageDays / halfLifeDays)`
- `ageDays` = days since `createdAt` (the locigram's creation timestamp)
- Floor at 0.5x — old memories never fully vanish
- If `halfLifeDays <= 0`, return results unchanged (disabled)

### 1c: MMR Diversity
```typescript
export function applyMMRDiversity(
  results: ScoredResult[],
  similarityThreshold: number = 0.85,  // env: LOCIGRAM_MMR_THRESHOLD
  penaltyFactor: number = 0.5,
): ScoredResult[]
```
Algorithm:
- Iterate through results (already sorted by score descending)
- For each result, compute text-based similarity (Jaccard on word trigrams) against all previously selected results
- If max similarity > threshold, multiply score by `penaltyFactor`
- Re-sort by adjusted score
- **Use word trigram Jaccard**, NOT cosine on embeddings (we don't have vectors in the recall route and adding them would bloat the response)

### Type
```typescript
export interface ScoredResult {
  id: string
  text: string
  createdAt: Date | string
  _score: number
  [key: string]: unknown
}
```

---

## Task 2: Wire scoring into recall route

**File:** `packages/server/src/routes/recall.ts` (MODIFY)

After the existing `results` mapping (line with `.map(r => ({ ...r, _score: ... }))`), add:

```typescript
import { applyLengthNormalization, applyTimeDecay, applyMMRDiversity } from '../scoring'

// ... existing code that builds `results` ...

// Post-Qdrant scoring pipeline
let scored = results
scored = applyLengthNormalization(scored, parseInt(process.env.LOCIGRAM_LENGTH_NORM_ANCHOR ?? '500'))
scored = applyTimeDecay(scored, parseInt(process.env.LOCIGRAM_QUERY_TIME_DECAY_HALFLIFE ?? '60'))
scored = applyMMRDiversity(scored, parseFloat(process.env.LOCIGRAM_MMR_THRESHOLD ?? '0.85'))

// Re-sort by adjusted score and apply hard minimum
scored = scored
  .filter(r => r._score >= (parseFloat(process.env.LOCIGRAM_HARD_MIN_SCORE ?? '0') || 0))
  .sort((a, b) => b._score - a._score)
```

Then return `scored` instead of `results`.

**Keep access tracking on original `ids`** — scoring doesn't change which results get tracked, only their order and scores.

---

## Task 3: Access reinforcement in sweep

**File:** `packages/truth/src/sweep.ts` (MODIFY)

Modify the CTE to use a per-row effective decay factor instead of the global fixed λ.

Current:
```sql
POWER(days_since + 1, ${DECAY_FACTOR})
```

New:
```sql
POWER(
  days_since + 1,
  ${DECAY_FACTOR} / LEAST(
    1 + ${REINFORCEMENT_FACTOR} * LOG(2, 1 + access_count),
    ${MAX_HALFLIFE_MULTIPLIER}
  )
)
```

Add env vars at top of file:
```typescript
const REINFORCEMENT_FACTOR    = parseFloat(process.env.LOCIGRAM_REINFORCEMENT_FACTOR ?? '0.5')
const MAX_HALFLIFE_MULTIPLIER = parseFloat(process.env.LOCIGRAM_MAX_HALFLIFE_MULTIPLIER ?? '3')
```

**Effect:** Higher access_count → smaller effective λ → slower decay → memory stays hot longer.

---

## Task 4: Noise filter module

**File:** `packages/pipeline/src/noise-filter.ts` (NEW)

```typescript
export function isNoise(text: string): boolean
export function filterNoise<T>(items: T[], getText: (item: T) => string): T[]
```

Patterns to match (return true = noise):
- Agent denials: "I don't have any information/data/memory/record"
- Meta questions: "do you remember", "can you recall", "did I tell you"
- Boilerplate: starts with "hi/hello/hey/good morning", "HEARTBEAT", "fresh session"
- Too short: < 5 chars after trim

**Wire into extraction pipeline:**
In `packages/pipeline/src/extract.ts`, add a check at the top of the extraction function:
```typescript
import { isNoise } from './noise-filter'
// At top of extract function:
if (isNoise(inputText)) {
  console.log('[extract] skipping noise:', inputText.slice(0, 50))
  return []  // or null, depending on the function signature
}
```

Check the existing extract function signature first and match it.

---

## Task 5: Unit tests

**File:** `packages/server/src/routes/__tests__/scoring.test.ts` (NEW)

Use Bun's built-in test runner (`bun:test`).

Test cases:
- Length norm: short text boosted, long text penalized, disabled when anchor=0
- Time decay: recent entry ~1.0, old entry ~0.5, disabled when halfLife=0
- MMR: near-duplicate texts get demoted, diverse texts unchanged
- Noise filter: denials, meta-questions, boilerplate, short text all caught; real content passes

---

## Files Changed Summary
| File | Action |
|------|--------|
| `packages/server/src/scoring.ts` | NEW |
| `packages/server/src/routes/recall.ts` | MODIFY |
| `packages/truth/src/sweep.ts` | MODIFY |
| `packages/pipeline/src/noise-filter.ts` | NEW |
| `packages/pipeline/src/extract.ts` | MODIFY (add noise check) |
| `packages/server/src/routes/__tests__/scoring.test.ts` | NEW |

## DO NOT TOUCH
- `packages/vector/` — no changes to Qdrant or embedding logic
- `packages/db/` — no schema changes needed
- `packages/server/src/app.ts` — no wiring changes needed
- Any `*.json` config files

## After Implementation
Commit with message: `feat(recall): post-Qdrant scoring pipeline + noise filter`
