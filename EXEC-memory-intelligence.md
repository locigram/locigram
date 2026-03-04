# EXEC: Memory Intelligence — Access Scoring, Temporal Decay, Co-Retrieval Clustering

**Date:** 2026-03-03  
**Repo:** `/tmp/locigram-agent/` → `github.com/locigram/locigram`  
**Remote:** `https://github.com/locigram/locigram.git`

---

## Shared Contract

**Golden Rule:** No two changes touch the same file from different tasks. Each task owns its files exclusively.

| File | Owner |
|------|-------|
| `packages/db/src/migrate.ts` | Task 1 |
| `packages/db/src/schema.ts` | Task 1 |
| `packages/server/src/routes/recall.ts` | Task 2 |
| `packages/truth/src/sweep.ts` | Task 3 (NEW) |
| `packages/pipeline/src/assess.ts` | Task 3 (NEW) |
| `packages/truth/src/cluster.ts` | Task 4 (NEW) |
| `packages/truth/src/promote.ts` | Task 4 |
| `packages/truth/src/detect.ts` | Task 4 |
| `packages/truth/src/scheduler.ts` | Task 4 |
| `packages/truth/src/index.ts` | Task 4 |
| `packages/server/src/app.ts` | Task 5 |
| `deploy/k8s/cronjobs.yaml` | Task 5 (NEW) |
| `.env.example` | Task 5 |

---

## Task 1 — Schema: new columns + retrieval_events table

### Files: `packages/db/src/migrate.ts`, `packages/db/src/schema.ts`

**In `migrate.ts`**, add 4 new columns to the `locigrams` CREATE TABLE statement:
```sql
-- after the existing `embedding_id TEXT` column:
access_count      INT         NOT NULL DEFAULT 0,
last_accessed_at  TIMESTAMPTZ,
access_score      FLOAT       NOT NULL DEFAULT 1.0,
cluster_candidate BOOLEAN     NOT NULL DEFAULT FALSE,
```

Add a new table after `sources`:
```sql
CREATE TABLE retrieval_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  palace_id     TEXT        NOT NULL REFERENCES palaces(id) ON DELETE CASCADE,
  query_text    TEXT,
  locigram_ids  TEXT[]      NOT NULL DEFAULT '{}',
  retrieved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

Add new indexes after existing locigrams indexes:
```sql
CREATE INDEX locigrams_access_score_idx      ON locigrams(palace_id, access_score);
CREATE INDEX locigrams_last_accessed_idx     ON locigrams(palace_id, last_accessed_at) WHERE last_accessed_at IS NOT NULL;
CREATE INDEX locigrams_cluster_candidate_idx ON locigrams(palace_id, cluster_candidate) WHERE cluster_candidate = TRUE;
```

Add index for retrieval_events:
```sql
CREATE INDEX retrieval_events_palace_idx  ON retrieval_events(palace_id, retrieved_at);
CREATE INDEX retrieval_events_ids_gin     ON retrieval_events USING GIN(locigram_ids);
```

**In `schema.ts`**, add to the locigrams table Drizzle definition:
```ts
accessCount:      integer('access_count').notNull().default(0),
lastAccessedAt:   timestamp('last_accessed_at', { withTimezone: true }),
accessScore:      real('access_score').notNull().default(1.0),
clusterCandidate: boolean('cluster_candidate').notNull().default(false),
```

Add a new Drizzle table definition for `retrieval_events`:
```ts
export const retrievalEvents = pgTable('retrieval_events', {
  id:          uuid('id').primaryKey().defaultRandom(),
  palaceId:    text('palace_id').notNull().references(() => palaces.id, { onDelete: 'cascade' }),
  queryText:   text('query_text'),
  locigramIds: text('locigram_ids').array().notNull().default([]),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull().defaultNow(),
})
```

Also export `retrievalEvents` from `packages/db/src/index.ts`.

---

## Task 2 — Recall route: increment access_count + log retrieval_events

### File: `packages/server/src/routes/recall.ts`

After fetching and sorting results, add two things:

**1. Increment access_count + set last_accessed_at on returned locigrams:**
```ts
// Fire-and-forget — don't block the response
if (ids.length > 0) {
  db.update(locigrams)
    .set({
      accessCount:     sql`access_count + 1`,
      lastAccessedAt:  new Date(),
    })
    .where(and(eq(locigrams.palaceId, palace.id), inArray(locigrams.id, ids)))
    .catch(err => console.warn('[recall] access_count update failed:', err))
}
```

**2. Log to retrieval_events:**
```ts
if (ids.length > 0) {
  db.insert(retrievalEvents)
    .values({
      palaceId:    palace.id,
      queryText:   query,
      locigramIds: ids,
    })
    .catch(err => console.warn('[recall] retrieval_events insert failed:', err))
}
```

Add `import { retrievalEvents } from '@locigram/db'` and `sql` from drizzle-orm to imports.

---

## Task 3 — Sweep worker + noise re-assessment

### Files: `packages/truth/src/sweep.ts` (NEW), `packages/pipeline/src/assess.ts` (NEW)

### `packages/truth/src/sweep.ts`

Nightly decay recomputation and tier demotion. Uses inverse power-law decay.

```ts
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '@locigram/db'
import { locigrams } from '@locigram/db'
import { eq, and, lt, isNotNull, inArray, sql } from 'drizzle-orm'

const DECAY_FACTOR         = parseFloat(process.env.LOCIGRAM_DECAY_FACTOR          ?? '0.6')
const HOT_THRESHOLD        = parseFloat(process.env.LOCIGRAM_DECAY_HOT_THRESHOLD   ?? '0.3')
const WARM_THRESHOLD       = parseFloat(process.env.LOCIGRAM_DECAY_WARM_THRESHOLD  ?? '0.1')
const NOISE_THRESHOLD      = parseFloat(process.env.LOCIGRAM_DECAY_NOISE_THRESHOLD ?? '0.05')

export async function runSweep(db: DB, palaceId: string): Promise<void> {
  console.log(`[sweep][${palaceId}] starting decay sweep`)
  const now = Date.now()

  // Fetch all hot + warm knowledge locigrams (skip is_reference — they never decay)
  const candidates = await db
    .select()
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palaceId),
        eq(locigrams.isReference, false),
        inArray(locigrams.tier, ['hot', 'warm']),
      )
    )

  let demotedToWarm = 0
  let demotedToCold = 0
  let queuedForAssess = 0

  for (const loc of candidates) {
    // Compute days since last access (use created_at if never accessed)
    const lastActivity = loc.lastAccessedAt ?? loc.createdAt
    const daysSince = (now - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)

    // Inverse power-law decay: access_score = access_count / (days + 1) ^ λ
    const newScore = loc.accessCount / Math.pow(daysSince + 1, DECAY_FACTOR)

    let newTier = loc.tier

    if (loc.tier === 'hot' && newScore < HOT_THRESHOLD) {
      newTier = 'warm'
      demotedToWarm++
    } else if (loc.tier === 'warm' && newScore < WARM_THRESHOLD) {
      newTier = 'cold'
      demotedToCold++
    }

    await db.update(locigrams)
      .set({ accessScore: newScore, tier: newTier })
      .where(eq(locigrams.id, loc.id))
  }

  // Queue cold + very-low-score locigrams for noise re-assessment
  const coldNoise = await db
    .select({ id: locigrams.id })
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palaceId),
        eq(locigrams.tier, 'cold'),
        eq(locigrams.isReference, false),
        lt(locigrams.accessScore, NOISE_THRESHOLD),
        sql`expires_at IS NULL`,  // not already expired
      )
    )

  // Mark as queued for assessment by setting metadata flag
  if (coldNoise.length > 0) {
    const ids = coldNoise.map(r => r.id)
    await db.update(locigrams)
      .set({ metadata: sql`metadata || '{"assess_queued": true}'::jsonb` })
      .where(and(eq(locigrams.palaceId, palaceId), inArray(locigrams.id, ids)))
    queuedForAssess = ids.length
  }

  console.log(`[sweep][${palaceId}] done — hot→warm: ${demotedToWarm}, warm→cold: ${demotedToCold}, queued for assess: ${queuedForAssess}`)
}

// Standalone entry point (for K8s CronJob)
if (import.meta.main) {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL required')
  const palaceId = process.env.PALACE_ID ?? 'main'

  const client = postgres(dbUrl, { max: 5 })
  const db = drizzle(client, { schema })

  await runSweep(db, palaceId)
  await client.end()
  process.exit(0)
}
```

### `packages/pipeline/src/assess.ts`

LLM noise re-assessment pass for cold + very-low-score locigrams.

```ts
import { locigrams } from '@locigram/db'
import { eq, and, sql } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import type { PipelineConfig } from './config'

export async function runNoiseAssessment(db: DB, palaceId: string, config: PipelineConfig): Promise<void> {
  console.log(`[assess][${palaceId}] starting noise re-assessment`)

  // Find locigrams queued for assessment
  const candidates = await db
    .select()
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palaceId),
        sql`metadata->>'assess_queued' = 'true'`,
      )
    )
    .limit(50)  // batch cap — don't hammer the LLM

  if (candidates.length === 0) {
    console.log(`[assess][${palaceId}] no candidates`)
    return
  }

  console.log(`[assess][${palaceId}] assessing ${candidates.length} candidates`)

  let expired = 0
  let kept = 0

  for (const loc of candidates) {
    const prompt = `You are evaluating a memory unit for a personal AI assistant. Determine if this memory is useful for future context recall.

Memory: "${loc.content}"
Source type: ${loc.sourceType}
Connector: ${loc.connector ?? 'unknown'}

Reply with ONLY a JSON object: { "useful": true|false, "reason": "one sentence" }

A memory is NOT useful if it is:
- Spam, marketing, or promotional content
- An automated notification with no context (e.g. "Your package has shipped")
- A one-liner chat message with no information content (e.g. "ok", "sounds good")
- A code snippet with no surrounding context about what it does or why
- Calendar accept/decline notifications

A memory IS useful if it contains:
- Facts about people, organizations, or relationships
- Decisions, commitments, or outcomes
- Technical configurations or system states
- Financial or operational information`

    try {
      const res = await fetch(`${config.extractUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.extractKey ? { Authorization: `Bearer ${config.extractKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.extractModel,
          messages: [{ role: 'user', content: config.extractNoThink ? prompt + ' /no_think' : prompt }],
          max_tokens: 100,
        }),
      })

      const text = await res.text()
      const body = JSON.parse(text)
      const content = body.choices?.[0]?.message?.content ?? ''

      // Strip think tags
      const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      const first = cleaned.indexOf('{')
      const last  = cleaned.lastIndexOf('}')
      if (first === -1 || last === -1) throw new Error('no JSON in response')

      const result = JSON.parse(cleaned.slice(first, last + 1)) as { useful: boolean; reason: string }

      if (!result.useful) {
        // Expire confirmed noise
        await db.update(locigrams)
          .set({
            expiresAt: new Date(),
            metadata:  sql`metadata - 'assess_queued' || jsonb_build_object('assess_result', 'noise', 'assess_reason', ${result.reason})`,
          })
          .where(eq(locigrams.id, loc.id))
        expired++
      } else {
        // Keep it — clear queue flag, set score floor
        await db.update(locigrams)
          .set({
            accessScore: 0.1,  // floor — prevent re-queuing immediately
            metadata:    sql`metadata - 'assess_queued' || jsonb_build_object('assess_result', 'kept', 'assess_reason', ${result.reason})`,
          })
          .where(eq(locigrams.id, loc.id))
        kept++
      }
    } catch (err) {
      // Clear queue flag on error to prevent infinite retry
      await db.update(locigrams)
        .set({ metadata: sql`metadata - 'assess_queued'` })
        .where(eq(locigrams.id, loc.id))
      console.warn(`[assess] failed on ${loc.id}:`, err)
    }
  }

  console.log(`[assess][${palaceId}] done — expired: ${expired}, kept: ${kept}`)
}
```

Also update `packages/pipeline/src/index.ts` to export `runNoiseAssessment`.

Task 3 also needs these packages in `packages/truth/package.json`:
```json
"postgres": "*",
"drizzle-orm": "*",
"@locigram/db": "workspace:*"
```

And in `packages/pipeline/package.json` no new deps needed (already has db + config).

---

## Task 4 — Co-occurrence cluster analyzer + update truth engine

### Files: `packages/truth/src/cluster.ts` (NEW), `packages/truth/src/detect.ts`, `packages/truth/src/promote.ts`, `packages/truth/src/scheduler.ts`, `packages/truth/src/index.ts`

### `packages/truth/src/cluster.ts`

```ts
import { locigrams, retrievalEvents } from '@locigram/db'
import { eq, and, sql, gte } from 'drizzle-orm'
import type { DB } from '@locigram/db'

const MIN_COOCCURRENCE  = parseInt(process.env.LOCIGRAM_CLUSTER_MIN_COOCCURRENCE ?? '5')
const WINDOW_DAYS       = parseInt(process.env.LOCIGRAM_CLUSTER_WINDOW_DAYS      ?? '30')

export async function runClusterAnalysis(db: DB, palaceId: string): Promise<void> {
  console.log(`[cluster][${palaceId}] starting co-occurrence analysis`)

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // Pairwise co-occurrence: unnest locigram_ids pairs from retrieval_events
  // Count how often each pair appears together in queries
  const pairs = await db.execute(sql`
    SELECT
      a.locigram_id AS id_a,
      b.locigram_id AS id_b,
      COUNT(*)::int  AS co_count
    FROM retrieval_events re,
         LATERAL unnest(re.locigram_ids) AS a(locigram_id),
         LATERAL unnest(re.locigram_ids) AS b(locigram_id)
    WHERE re.palace_id = ${palaceId}
      AND re.retrieved_at >= ${since}
      AND a.locigram_id < b.locigram_id   -- deduplicate pairs (a < b alphabetically)
    GROUP BY a.locigram_id, b.locigram_id
    HAVING COUNT(*) >= ${MIN_COOCCURRENCE}
    ORDER BY co_count DESC
    LIMIT 500
  `) as Array<{ id_a: string; id_b: string; co_count: number }>

  if (pairs.length === 0) {
    console.log(`[cluster][${palaceId}] no pairs above threshold`)
    return
  }

  // Collect all IDs that appear in qualifying pairs
  const candidateIds = new Set<string>()
  for (const p of pairs) {
    candidateIds.add(p.id_a)
    candidateIds.add(p.id_b)
  }

  // Flag all candidates
  await db.execute(sql`
    UPDATE locigrams
    SET cluster_candidate = TRUE
    WHERE palace_id = ${palaceId}
      AND id = ANY(${[...candidateIds]}::uuid[])
      AND is_reference = FALSE
      AND tier != 'cold'
  `)

  console.log(`[cluster][${palaceId}] flagged ${candidateIds.size} candidates from ${pairs.length} qualifying pairs`)
}

// Standalone entry point (for K8s CronJob)
if (import.meta.main) {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL required')
  const palaceId = process.env.PALACE_ID ?? 'main'

  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const schema = await import('@locigram/db')

  const client = postgres(dbUrl, { max: 5 })
  const db = drizzle(client, { schema: schema as any })

  await runClusterAnalysis(db, palaceId)
  await client.end()
  process.exit(0)
}
```

### Update `packages/truth/src/detect.ts`

Add a second export function `detectClusterGroups`:
```ts
export async function detectClusterGroups(
  db: DB,
  palaceId: string,
): Promise<ReinforcementGroup[]> {
  // Find all cluster candidates
  const candidates = await db
    .select()
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palaceId),
        eq(locigrams.clusterCandidate, true),
        eq(locigrams.isReference, false),
      )
    )

  if (candidates.length === 0) return []

  // Group by locus + entity overlap (same as existing detect logic)
  const groups = new Map<string, ReinforcementGroup>()
  for (const loc of candidates) {
    const key = `${loc.locus}::${[...loc.entities].sort().join(',')}`
    if (groups.has(key)) {
      const g = groups.get(key)!
      g.locigramIds.push(loc.id)
      g.count++
    } else {
      groups.set(key, { locus: loc.locus, entities: loc.entities, locigramIds: [loc.id], count: 1 })
    }
  }

  return [...groups.values()].filter(g => g.count >= 2)
}
```

### Update `packages/truth/src/promote.ts`

After promoting source locigrams to cold (at end of promoteToTruth), also clear their `cluster_candidate` flag:
```ts
// After setting tier to cold on source locigrams, add:
await db.update(locigrams)
  .set({ clusterCandidate: false })
  .where(and(eq(locigrams.palaceId, palaceId), inArray(locigrams.id, group.locigramIds)))
```

### Update `packages/truth/src/scheduler.ts`

The scheduler currently runs detect + promote every 6 hours. Add cluster detection:
```ts
// In the scheduler loop, after existing truth engine run, add:
// Run cluster promotion (also every 6 hours — cluster worker flags candidates weekly, promote runs more often)
const clusterGroups = await detectClusterGroups(db, palaceId)
for (const group of clusterGroups) {
  const statement = group.locigramIds.length > 0
    ? `[Cluster] ${group.entities.join(', ')} — ${group.locigramIds.length} related observations`
    : 'Related observations merged'
  await promoteToTruth(db, palaceId, group, statement)
}
```

### Update `packages/truth/src/index.ts`

Export `runClusterAnalysis` from `cluster.ts` and `detectClusterGroups` from `detect.ts`.

---

## Task 5 — Wire workers + K8s CronJobs + env vars

### `packages/server/src/app.ts`

Import and schedule the sweep and assess workers to run in-process (fallback for non-K8s deployments):

```ts
import { runSweep } from '@locigram/truth'
import { runNoiseAssessment } from '@locigram/pipeline'

// Schedule nightly sweep (in-process fallback — K8s CronJob preferred)
// Only run in-process if LOCIGRAM_DISABLE_INPROCESS_SWEEP is not set
if (!process.env.LOCIGRAM_DISABLE_INPROCESS_SWEEP) {
  const SWEEP_INTERVAL = 24 * 60 * 60 * 1000  // 24h
  setInterval(async () => {
    try {
      await runSweep(db, palace.id)
      await runNoiseAssessment(db, palace.id, pipelineConfig)
    } catch (err) {
      console.error('[scheduler] sweep failed:', err)
    }
  }, SWEEP_INTERVAL)
}
```

### `deploy/k8s/cronjobs.yaml` (NEW)

```yaml
# K8s CronJob manifests for Locigram background workers
# Apply to the same namespace as the palace: kubectl apply -f cronjobs.yaml -n locigram-main
# Replace <palace-id> and <namespace> with actual values

---
# Nightly sweep: decay recomputation + tier demotion + noise queuing
apiVersion: batch/v1
kind: CronJob
metadata:
  name: locigram-sweep
  namespace: locigram-<palace-id>
spec:
  schedule: "0 2 * * *"        # 2am daily
  concurrencyPolicy: Forbid     # don't overlap runs
  jobTemplate:
    spec:
      template:
        spec:
          imagePullSecrets:
            - name: ghcr-pull-secret
          restartPolicy: OnFailure
          containers:
            - name: sweep
              image: ghcr.io/locigram/locigram:latest
              command: ["/bin/sh", "-c", "bun run packages/truth/src/sweep.ts"]
              envFrom:
                - configMapRef:
                    name: locigram-config
                - secretRef:
                    name: locigram-secrets
              env:
                - name: DATABASE_URL
                  value: "postgresql://locigram:$(POSTGRES_PASSWORD)@locigram-postgres:5432/locigram"
                - name: LOCIGRAM_DECAY_FACTOR
                  value: "0.6"
                - name: LOCIGRAM_DECAY_HOT_THRESHOLD
                  value: "0.3"
                - name: LOCIGRAM_DECAY_WARM_THRESHOLD
                  value: "0.1"
                - name: LOCIGRAM_DECAY_NOISE_THRESHOLD
                  value: "0.05"

---
# Weekly cluster analysis: co-occurrence pairwise SQL + cluster_candidate flagging
apiVersion: batch/v1
kind: CronJob
metadata:
  name: locigram-cluster
  namespace: locigram-<palace-id>
spec:
  schedule: "0 3 * * 0"        # 3am every Sunday
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          imagePullSecrets:
            - name: ghcr-pull-secret
          restartPolicy: OnFailure
          containers:
            - name: cluster
              image: ghcr.io/locigram/locigram:latest
              command: ["/bin/sh", "-c", "bun run packages/truth/src/cluster.ts"]
              envFrom:
                - configMapRef:
                    name: locigram-config
                - secretRef:
                    name: locigram-secrets
              env:
                - name: DATABASE_URL
                  value: "postgresql://locigram:$(POSTGRES_PASSWORD)@locigram-postgres:5432/locigram"
                - name: LOCIGRAM_CLUSTER_MIN_COOCCURRENCE
                  value: "5"
                - name: LOCIGRAM_CLUSTER_WINDOW_DAYS
                  value: "30"
```

### `.env.example`

Add new env vars section:
```env
# ── Memory intelligence (temporal decay + co-retrieval clustering) ────────────
LOCIGRAM_DECAY_FACTOR=0.6              # λ exponent in inverse power-law decay formula
LOCIGRAM_DECAY_HOT_THRESHOLD=0.3       # access_score below this → demote hot to warm
LOCIGRAM_DECAY_WARM_THRESHOLD=0.1      # access_score below this → demote warm to cold
LOCIGRAM_DECAY_NOISE_THRESHOLD=0.05    # access_score below this → queue cold for LLM re-assessment
LOCIGRAM_CLUSTER_MIN_COOCCURRENCE=5    # min co-retrievals in window to flag as cluster_candidate
LOCIGRAM_CLUSTER_WINDOW_DAYS=30        # lookback window for co-occurrence analysis (days)
LOCIGRAM_DISABLE_INPROCESS_SWEEP=      # set to "true" when using K8s CronJobs (avoids double-run)
```

---

## Acceptance Criteria

- [ ] `bun run packages/db/src/migrate.ts` completes without error and creates all new columns + retrieval_events table
- [ ] `GET /api/health` still returns 200 after schema changes
- [ ] `POST /api/recall` increments `access_count` and inserts a `retrieval_events` row
- [ ] `bun run packages/truth/src/sweep.ts` runs to completion with correct log output
- [ ] `bun run packages/truth/src/cluster.ts` runs to completion
- [ ] All new code compiles without TypeScript errors
- [ ] No secrets committed to git
- [ ] Final commit pushed to `origin main`

---

## Commit Strategy

One commit per completed task:
- `feat(db): schema v3 — access scoring columns + retrieval_events table`
- `feat(recall): increment access_count + log retrieval_events per query`
- `feat(sweep): nightly decay worker — inverse power-law decay, tier demotion, noise assessment queue`
- `feat(cluster): co-occurrence analyzer — pairwise co-retrieval SQL, cluster_candidate flagging`
- `feat(workers): K8s CronJob manifests + in-process scheduler + env vars`
