# EXEC Plan: Phase 2 — Capture Quality (Structured Reflection Format)

## Objective
Add a `category` column to locigrams so every memory is typed on extraction. Enable category-filtered recall.

## Shared Contract
- **Repo:** `/Users/surubot/locigram`
- **Branch:** work on `main` directly (single developer)
- **Test:** `cd packages/server && npx vitest run` — all tests must pass before committing
- **DB:** Postgres at `10.10.100.90:30543`, database `locigram`, accessed via Drizzle ORM
- **No destructive migrations** — `ALTER TABLE ADD COLUMN IF NOT EXISTS` only
- **Commit format:** `feat(pipeline): ...` or `feat(recall): ...`
- **Do NOT touch:** OAuth tables, connector tables, truth engine core logic

## Changes

### 1. Schema: Add `category` column to `locigrams` table

**File:** `packages/db/src/schema.ts`

Add to the `locigrams` table definition, after `importance`:

```typescript
category: text('category').notNull().default('observation'),
// decision | preference | fact | lesson | entity | observation
```

Add index:
```typescript
index('locigrams_category_idx').on(t.palaceId, t.category),
```

**File:** `packages/db/src/index.ts`

Export the category constants:
```typescript
export const LOCIGRAM_CATEGORIES = [
  'decision',     // "we decided to use X", "approved Y"
  'preference',   // "I prefer X", "always do Y", "from now on"
  'fact',         // "X costs $Y", "their IP is Z", factual statements
  'lesson',       // "we learned that", "next time we should", "mistake was"
  'entity',       // "X is a person/org/product" — pure entity knowledge
  'observation',  // default — general notes, events, conversations
] as const
export type LocigramCategory = typeof LOCIGRAM_CATEGORIES[number]
```

**File:** `packages/db/src/migrate.ts`

Add idempotent migration:
```sql
ALTER TABLE locigrams ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'observation';
CREATE INDEX IF NOT EXISTS locigrams_category_idx ON locigrams (palace_id, category);
```

### 2. Extraction: Classify category during LLM extraction

**File:** `packages/pipeline/src/extract.ts`

Update `ExtractionSchema`:
```typescript
const ExtractionSchema = z.object({
  // ... existing fields ...
  locigrams: z.array(z.object({
    content:    z.string(),
    confidence: z.number().min(0).max(1),
    category:   z.enum(['decision', 'preference', 'fact', 'lesson', 'entity', 'observation']).default('observation'),
  })),
})
```

Update `SYSTEM_PROMPT` — add to the schema section:
```
"locigrams": [{ "content": string, "confidence": number, "category": "decision"|"preference"|"fact"|"lesson"|"entity"|"observation" }]
```

Add to Rules section:
```
- category: classify each locigram:
    decision = explicit choices made ("we decided", "approved", "going with", "chosen")
    preference = stated likes/dislikes/defaults ("I prefer", "always use", "from now on", "don't ever")
    fact = verifiable statements (costs, IPs, dates, specs, identities)
    lesson = learned from experience ("we learned", "next time", "mistake was", "note to self")
    entity = pure entity knowledge (who someone is, what an org does, product descriptions)
    observation = default — events, conversations, general notes, anything that doesn't fit above
```

Update the `fallback()` function to include `category: 'observation'` in the returned locigram.

### 3. Ingest: Pass category through to DB insert

**File:** `packages/pipeline/src/ingest.ts`

In the `db.insert(locigrams).values({...})` call, add:
```typescript
category: loc.category ?? 'observation',
```

For `preClassified` path, default to `'fact'` (structured data from connectors is factual by nature):
```typescript
locigrams: [{ content: raw.content, confidence: 1.0, category: 'fact' }],
```

### 4. Recall: Support category filter

**File:** `packages/server/src/routes/recall.ts`

Add `category` to the request schema:
```typescript
category: z.enum(['decision', 'preference', 'fact', 'lesson', 'entity', 'observation']).optional(),
```

If `category` is provided, add a Postgres WHERE filter on the results after fetching from Qdrant:
```typescript
if (category) {
  scored = scored.filter(r => r.category === category)
}
```

Also pass category to Qdrant payload filter if set (add to the vectorClient.search options).

### 5. MCP: Expose category filter in recall tool

**File:** `packages/server/src/routes/mcp.ts` (or wherever MCP tools are defined)

Add `category` as an optional parameter to the `memory_recall` tool schema:
```typescript
category: { type: 'string', enum: ['decision', 'preference', 'fact', 'lesson', 'entity', 'observation'], description: 'Filter by memory category' }
```

Pass it through to the recall POST body.

### 6. Tests

**File:** `packages/server/src/routes/__tests__/scoring.test.ts` (or new test file)

Add tests:
- Extraction produces correct category for each type (mock LLM responses)
- Recall with category filter returns only matching category
- Default category is 'observation' when not specified
- preClassified data gets category 'fact'

### 7. Qdrant payload

When storing in Qdrant (embedding worker), include `category` in the payload metadata so it can be used as a pre-filter. Find where Qdrant upsert happens and add `category` to the payload.

## NOT in scope
- Per-turn real-time capture (deferred — needs OpenClaw plugin work)
- Skip retrieval for non-memory queries (deferred — needs OpenClaw changes)
- Backfilling existing locigrams with categories (separate task, can run post-deploy)

## Deploy
After commit:
1. `cd /Users/surubot/locigram && docker build -t ghcr.io/locigram/locigram-server:latest .`
   - Build on surugpu: `sshpass -p "<gpu_pass>" ssh ale@10.10.100.20 "cd /home/ale/locigram && git pull && docker build -t ghcr.io/locigram/locigram-server:latest . && docker push ghcr.io/locigram/locigram-server:latest"`
2. K3s rollout: `sudo kubectl rollout restart deployment locigram-server -n locigram-main`
3. Verify: `curl http://10.10.100.82:30310/api/health`
