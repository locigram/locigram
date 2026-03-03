import { z } from 'zod'
import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface MemoryApiConnectorConfig {
  /**
   * Base URL of the OpenClaw local-api (memory endpoints).
   * Default: http://localhost:3200
   */
  baseUrl: string

  /** Bearer token for Authorization header */
  token: string

  /** Which resources to pull (default: both) */
  sources?: Array<'observations' | 'lessons'>

  /** Max records per source per pull (default 500) */
  limit?: number
}

// ── Response schemas (real API shape confirmed) ───────────────────────────────

const ObservationSchema = z.object({
  id:             z.string(),
  category:       z.string(),
  observation:    z.string(),
  confidence:     z.number().optional(),
  source:         z.string().optional(),
  last_confirmed: z.string().optional(),
  created_at:     z.string(),
})

const LessonSchema = z.object({
  id:          z.string(),
  lesson:      z.string(),
  context:     z.string().nullable().optional(),
  category:    z.string(),
  severity:    z.string().optional(),
  created_at:  z.string(),
})

const ListResponseSchema = z.object({
  data: z.object({
    items: z.array(z.unknown()),
  }),
})

async function fetchAll<T>(
  baseUrl: string,
  token:   string,
  path:    string,
  limit:   number,
  since?:  Date,
): Promise<T[]> {
  const url = new URL(`${baseUrl}${path}`)
  url.searchParams.set('limit', String(limit))
  if (since) url.searchParams.set('since', since.toISOString())

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) throw new Error(`[memory-api] ${path} failed: ${res.status}`)

  const raw    = await res.json()
  const parsed = ListResponseSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`[memory-api] unexpected response shape from ${path}`)

  return parsed.data.data.items as T[]
}

export function createMemoryApiConnector(config: MemoryApiConnectorConfig): ConnectorPlugin {
  const sources = config.sources ?? ['observations', 'lessons']
  const limit   = config.limit   ?? 500
  const base    = config.baseUrl.replace(/\/$/, '')

  return {
    name: 'memory-api',

    validate(cfg: unknown): cfg is MemoryApiConnectorConfig {
      return (
        typeof cfg === 'object' &&
        cfg !== null &&
        'baseUrl' in cfg &&
        'token' in cfg
      )
    },

    async pull(since?: Date): Promise<RawMemory[]> {
      const results: RawMemory[] = []

      if (sources.includes('observations')) {
        const items = await fetchAll(base, config.token, '/api/memory/observations', limit, since)

        for (const raw of items) {
          const parsed = ObservationSchema.safeParse(raw)
          if (!parsed.success) continue
          const o = parsed.data

          results.push({
            content:    o.observation,
            sourceType: 'system' as const,
            sourceRef:  `memory-api:observation:${o.id}`,
            occurredAt: new Date(o.created_at),
            metadata:   {
              category:   o.category,
              confidence: o.confidence,
              source:     o.source,
              connector:  'memory-api',
            },
          })
        }
      }

      if (sources.includes('lessons')) {
        const items = await fetchAll(base, config.token, '/api/memory/lessons', limit, since)

        for (const raw of items) {
          const parsed = LessonSchema.safeParse(raw)
          if (!parsed.success) continue
          const l = parsed.data

          results.push({
            content:    `Lesson [${l.category}${l.severity ? `/${l.severity}` : ''}]: ${l.lesson}${l.context ? `\nContext: ${l.context}` : ''}`,
            sourceType: 'system' as const,
            sourceRef:  `memory-api:lesson:${l.id}`,
            occurredAt: new Date(l.created_at),
            metadata:   {
              category:  l.category,
              severity:  l.severity,
              connector: 'memory-api',
            },
          })
        }
      }

      return results
    },
  }
}
