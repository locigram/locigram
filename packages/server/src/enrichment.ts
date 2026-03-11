// ── Enrichment Loop ─────────────────────────────────────────────────────────
// Extracts structured facts from resolved source material and ingests them
// back into Locigram. Includes safety guards for sensitive data, circular
// enrichment, and rate limiting.

import type { DB } from '@locigram/db'
import { locigrams } from '@locigram/db'
import { eq, and, isNull } from 'drizzle-orm'
import type { SourceResolution } from './source-resolver'
import type { PipelineConfig } from '@locigram/pipeline'

// ── Config ──────────────────────────────────────────────────────────────────

export interface EnrichmentConfig {
  enabled: boolean               // Global kill switch
  maxFactsPerEnrichment: number  // Rate limit per drill-down (default 10)
  emailEnrichmentEnabled: boolean // Off by default — email bodies too sensitive
}

export const DEFAULT_ENRICHMENT_CONFIG: EnrichmentConfig = {
  enabled: true,
  maxFactsPerEnrichment: 10,
  emailEnrichmentEnabled: false,
}

// ── Result ──────────────────────────────────────────────────────────────────

export interface EnrichmentResult {
  factsExtracted: number
  factsIngested: number
  factsSkipped: number
  skippedReasons: string[]
  blocked: boolean
  blockReason?: string
}

// ── Sensitive data patterns ─────────────────────────────────────────────────

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@/, label: 'credentials-in-url' },
  { pattern: /\bsk-[a-zA-Z0-9]{20,}/, label: 'api-key-openai' },
  { pattern: /\b(token|api[_-]?key|secret|password)\s*[=:]\s*\S{8,}/i, label: 'key-value-credential' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'ssn' },
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, label: 'credit-card' },
  { pattern: /\bBEGIN\s+(RSA\s+)?PRIVATE\s+KEY\b/, label: 'private-key' },
  { pattern: /\bghp_[a-zA-Z0-9]{36,}/, label: 'github-pat' },
  { pattern: /\bglpat-[a-zA-Z0-9\-_]{20,}/, label: 'gitlab-pat' },
]

// ── Circular enrichment exclusion ───────────────────────────────────────────

const EXCLUDED_OBSIDIAN_PATHS = new Set([
  'Brain/Agent-Write-Policy.md',
  'Brain/Locigram-Ingestion-Policy.md',
  'Brain/Vault-Structure.md',
])

const EXCLUDED_PATH_PREFIXES = [
  'Agents/',
]

function isCircularSource(sourceRef: string): boolean {
  if (!sourceRef.startsWith('obsidian:')) return false
  // Extract path — everything between 'obsidian:' and the last ':Lnn' segment
  const rest = sourceRef.slice('obsidian:'.length)
  const parts = rest.split(':')
  const lastPart = parts[parts.length - 1]
  const path = (lastPart?.startsWith('L') && /^L\d+$/.test(lastPart))
    ? parts.slice(0, -1).join(':')
    : rest

  if (EXCLUDED_OBSIDIAN_PATHS.has(path)) return true
  if (EXCLUDED_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) return true
  return false
}

// ── Sensitivity check ───────────────────────────────────────────────────────

function checkSensitivity(text: string): { sensitive: boolean; matches: string[] } {
  const matches: string[] = []
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) matches.push(label)
  }
  return { sensitive: matches.length > 0, matches }
}

// ── Cosine similarity ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ── Vector ops interface (subset of VectorOps from tools.ts) ────────────────

interface EnrichVectorOps {
  embed: (text: string) => Promise<number[]>
  upsert: (collection: string, id: string, vector: number[], payload: Record<string, unknown>) => Promise<void>
}

// ── Main enrichment function ────────────────────────────────────────────────

export async function enrichFromSource(
  resolution: SourceResolution,
  db: DB,
  palaceId: string,
  pipelineConfig: PipelineConfig,
  vectorOps: EnrichVectorOps,
  collection: string,
  config: EnrichmentConfig = DEFAULT_ENRICHMENT_CONFIG,
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    factsExtracted: 0,
    factsIngested: 0,
    factsSkipped: 0,
    skippedReasons: [],
    blocked: false,
  }

  // ── Guards ──────────────────────────────────────────────────────────────

  if (!config.enabled) {
    result.blocked = true
    result.blockReason = 'Enrichment globally disabled'
    return result
  }

  if (!resolution.resolved || !resolution.material) {
    result.blocked = true
    result.blockReason = 'Source not resolved'
    return result
  }

  if (resolution.platform === 'email' && !config.emailEnrichmentEnabled) {
    result.blocked = true
    result.blockReason = 'Email enrichment disabled (opt-in only)'
    return result
  }

  if (isCircularSource(resolution.sourceRef)) {
    result.blocked = true
    result.blockReason = `Circular enrichment detected: ${resolution.sourceRef}`
    console.warn(`[enrichment] circular source blocked: ${resolution.sourceRef}`)
    return result
  }

  const fullMaterial = resolution.material + (resolution.contextWindow ? '\n' + resolution.contextWindow : '')

  const materialSensitivity = checkSensitivity(fullMaterial)
  if (materialSensitivity.sensitive) {
    result.blocked = true
    result.blockReason = `Sensitive data in source: ${materialSensitivity.matches.join(', ')}`
    console.warn(`[enrichment] sensitive source blocked: ${materialSensitivity.matches.join(', ')}`)
    return result
  }

  // ── Extract structured facts via LLM ────────────────────────────────────

  const { extractFromRaw } = await import('@locigram/pipeline')

  const extraction = await extractFromRaw(
    {
      content: fullMaterial,
      sourceType: 'enrichment',
      metadata: { sourceRef: resolution.sourceRef, platform: resolution.platform },
    },
    pipelineConfig,
  )

  result.factsExtracted = extraction.locigrams.length

  // Rate limit
  const factsToProcess = extraction.locigrams.slice(0, config.maxFactsPerEnrichment)
  if (extraction.locigrams.length > config.maxFactsPerEnrichment) {
    const dropped = extraction.locigrams.length - config.maxFactsPerEnrichment
    result.factsSkipped += dropped
    result.skippedReasons.push(`Rate limited: ${dropped} facts over limit of ${config.maxFactsPerEnrichment}`)
  }

  // ── Dedup + ingest each fact ────────────────────────────────────────────

  for (const fact of factsToProcess) {
    // Skip unstructured facts (no SPO triple = not useful for structured recall)
    if (!fact.subject && !fact.predicate) {
      result.factsSkipped++
      result.skippedReasons.push(`No structured fields: ${fact.content.slice(0, 50)}`)
      continue
    }

    // Cache for object_val embedding (reused in dedup + ingest)
    let cachedObjectValVec: number[] | null = null

    // Per-fact sensitivity check
    const factText = `${fact.content} ${fact.object_val ?? ''}`
    const factSensitivity = checkSensitivity(factText)
    if (factSensitivity.sensitive) {
      result.factsSkipped++
      result.skippedReasons.push(`Sensitive fact: ${factSensitivity.matches.join(', ')}`)
      continue
    }

    // Tier 1 dedup: exact subject + predicate match
    if (fact.subject && fact.predicate) {
      const existing = await db
        .select({ id: locigrams.id, objectVal: locigrams.objectVal })
        .from(locigrams)
        .where(
          and(
            eq(locigrams.palaceId, palaceId),
            eq(locigrams.subject, fact.subject),
            eq(locigrams.predicate, fact.predicate),
            isNull(locigrams.expiresAt),
          ),
        )
        .limit(5)

      if (existing.length > 0) {
        if (fact.object_val) {
          // Tier 2: fuzzy dedup on object_val via embedding cosine similarity
          // Cache the new embedding — reuse for ingest if not a duplicate
          let isDuplicate = false
          if (!cachedObjectValVec) {
            cachedObjectValVec = await vectorOps.embed(fact.object_val)
          }

          for (const ex of existing) {
            if (ex.objectVal) {
              const exVec = await vectorOps.embed(ex.objectVal)
              if (cosineSimilarity(cachedObjectValVec, exVec) > 0.9) {
                isDuplicate = true
                break
              }
            }
          }

          if (isDuplicate) {
            result.factsSkipped++
            result.skippedReasons.push(`Fuzzy duplicate: ${fact.subject}/${fact.predicate}`)
            continue
          }
        } else {
          // Same subject+predicate, no object_val to compare — skip
          result.factsSkipped++
          result.skippedReasons.push(`Exact duplicate: ${fact.subject}/${fact.predicate}`)
          continue
        }
      }
    }

    // ── Ingest ──────────────────────────────────────────────────────────

    try {
      const [stored] = await db
        .insert(locigrams)
        .values({
          content: fact.content,
          sourceType: 'enrichment',
          sourceRef: resolution.sourceRef,
          connector: 'enrichment',
          locus: extraction.locus,
          category: fact.category ?? 'observation',
          subject: fact.subject ?? null,
          predicate: fact.predicate ?? null,
          objectVal: fact.object_val ?? null,
          durabilityClass: fact.durability_class ?? 'active',
          tier: 'hot',
          confidence: fact.confidence,
          isReference: extraction.isReference ?? false,
          referenceType: extraction.referenceType ?? null,
          entities: [],
          metadata: { enrichedFrom: resolution.sourceRef, platform: resolution.platform },
          palaceId,
        })
        .returning()

      // Embed + upsert to Qdrant
      const vec = await vectorOps.embed(fact.content)
      await vectorOps.upsert(collection, stored.id, vec, {
        palace_id: palaceId,
        locus: extraction.locus,
        source_type: 'enrichment',
        connector: 'enrichment',
        entities: [],
        confidence: fact.confidence,
        category: fact.category ?? 'observation',
        subject: fact.subject ?? null,
        predicate: fact.predicate ?? null,
        durability_class: fact.durability_class ?? 'active',
        created_at: stored.createdAt.toISOString(),
      })

      await db
        .update(locigrams)
        .set({ embeddingId: stored.id })
        .where(eq(locigrams.id, stored.id))

      result.factsIngested++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.skippedReasons.push(`Ingest error: ${msg}`)
      console.error(`[enrichment] ingest failed:`, msg)
    }
  }

  console.log(
    `[enrichment] ${resolution.sourceRef}: extracted=${result.factsExtracted} ingested=${result.factsIngested} skipped=${result.factsSkipped}${result.blocked ? ' BLOCKED=' + result.blockReason : ''}`,
  )

  return result
}
