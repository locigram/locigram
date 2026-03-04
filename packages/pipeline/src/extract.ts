import { z } from 'zod'
import type { RawMemory } from '@locigram/core'
import type { PipelineConfig, LLMRole } from './config'

const ExtractionSchema = z.object({
  entities: z.array(z.object({
    name:    z.string(),
    type:    z.enum(['person', 'org', 'product', 'topic', 'place']),
    aliases: z.array(z.string()).default([]),
  })),
  locus:     z.string(),
  locigrams: z.array(z.object({
    content:    z.string(),
    confidence: z.number().min(0).max(1),
  })),
})

export type ExtractionResult = z.infer<typeof ExtractionSchema>

const SYSTEM_PROMPT = `You are a memory extraction assistant. Given text, extract structured memory.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation. Just JSON.

Schema:
{
  "entities": [{ "name": string, "type": "person"|"org"|"product"|"topic"|"place", "aliases": string[] }],
  "locus": string,
  "locigrams": [{ "content": string, "confidence": number }]
}

Rules:
- locus format: "people/name", "business/orgname", "technical/topic", "personal/topic", "project/name"
- locigrams: break into individual facts or events, each standalone and plain language
- confidence: 0.0–1.0 (how certain this fact is)
- aliases: other names or abbreviations for the entity (can be empty array)`

function fallback(raw: RawMemory): ExtractionResult {
  return {
    entities: [],
    locus: 'personal/general',
    locigrams: [{ content: raw.content, confidence: 0.5 }],
  }
}

function authHeaders(role: LLMRole): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (role.apiKey) h['Authorization'] = `Bearer ${role.apiKey}`
  return h
}

export async function extractFromRaw(
  raw: RawMemory,
  config: PipelineConfig,
): Promise<ExtractionResult> {
  const role = config.llm.extract
  try {
    const res = await fetch(`${role.url}/chat/completions`, {
      method:  'POST',
      headers: authHeaders(role),
      body: JSON.stringify({
        model: role.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: raw.content },
        ],
        temperature: 0.1,
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.warn(`[pipeline] extraction LLM error: ${res.status} ${errBody.slice(0, 300)}`)
      return fallback(raw)
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> }
    const content = data?.choices?.[0]?.message?.content
    if (!content) return fallback(raw)

    console.log('[pipeline] LLM content:', content)

    // Strip markdown code fences if present
    const cleanJson = content.replace(/```json\n?|```/g, '').trim()

    try {
      const parsed = ExtractionSchema.safeParse(JSON.parse(cleanJson))
      if (!parsed.success) {
        console.warn('[pipeline] extraction schema mismatch:', parsed.error.message)
        return fallback(raw)
      }
      return parsed.data
    } catch (e) {
      console.warn('[pipeline] JSON parse failed for content:', content)
      throw e
    }
  } catch (err) {
    console.warn('[pipeline] extraction failed:', err)
    return fallback(raw)
  }
}
