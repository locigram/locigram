/**
 * GLiNER client — fast NER pre-extraction before LLM call.
 * If GLINER_URL is not set or the request fails, returns null (graceful degradation).
 */

export interface GLiNEREntity {
  text:  string
  type:  string
  score: number
  start: number
  end:   number
}

// Map GLiNER types → Locigram entity types
const TYPE_MAP: Record<string, 'person' | 'org' | 'product' | 'topic' | 'place'> = {
  person:       'person',
  organization: 'org',
  org:          'org',
  location:     'place',
  place:        'place',
  product:      'product',
  software:     'product',
  topic:        'topic',
  event:        'topic',
  ip_address:   'topic',
  date:         'topic',
}

export interface GLiNERMention {
  rawText:    string
  type:       string   // mapped Locigram type (person|org|product|topic|place)
  confidence: number
  spanStart:  number
  spanEnd:    number
}

export interface GLiNERResult {
  entities: Array<{
    name: string
    type: 'person' | 'org' | 'product' | 'topic' | 'place'
    aliases: string[]
  }>
  /** Raw mentions with confidence + spans for entity_mentions table */
  mentions: GLiNERMention[]
  durationMs: number
}

const ENTITY_TYPES = [
  'person',
  'organization',
  'location',
  'product',
  'software',
  'ip_address',
  'date',
  'event',
  'topic',
]

let _url: string | null | undefined = undefined

function getUrl(): string | null {
  if (_url !== undefined) return _url
  _url = process.env.GLINER_URL ?? null
  return _url
}

export async function extractEntitiesWithGLiNER(text: string): Promise<GLiNERResult | null> {
  const url = getUrl()
  if (!url) return null

  try {
    const res = await fetch(`${url}/extract`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, entity_types: ENTITY_TYPES, threshold: 0.4 }),
      signal:  AbortSignal.timeout(10_000), // 10s max — GLiNER can be slow under load
    })

    if (!res.ok) {
      console.warn(`[gliner] HTTP ${res.status} — skipping pre-extraction`)
      return null
    }

    const data = await res.json() as {
      entities: GLiNEREntity[]
      duration_ms: number
    }

    const CONFIDENCE_FLOOR = 0.5

    // Build raw mentions (above floor) for entity_mentions storage
    const mentions: GLiNERMention[] = data.entities
      .filter(e => e.score >= CONFIDENCE_FLOOR)
      .map(e => ({
        rawText:    e.text,
        type:       TYPE_MAP[e.type] ?? 'topic',
        confidence: e.score,
        spanStart:  e.start,
        spanEnd:    e.end,
      }))

    // Deduplicate by normalized text, map types (for LLM hints — keep all above threshold 0.4)
    const seen = new Map<string, GLiNERResult['entities'][number]>()
    for (const e of data.entities) {
      const key = e.text.toLowerCase().trim()
      if (!seen.has(key)) {
        seen.set(key, {
          name:    e.text,
          type:    TYPE_MAP[e.type] ?? 'topic',
          aliases: [],
        })
      }
    }

    return {
      entities:   [...seen.values()],
      mentions,
      durationMs: data.duration_ms,
    }
  } catch (err) {
    console.warn('[gliner] extraction failed — falling back to LLM-only:', (err as Error).name, (err as Error).message)
    return null
  }
}
