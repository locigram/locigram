import { z } from 'zod'
import type { RawMemory } from '@locigram/core'
import type { PipelineConfig, LLMRole } from './config'
import { REFERENCE_TYPES } from '@locigram/db'

// ── Regex patterns for reference data detection ───────────────────────────────

const REFERENCE_PATTERNS = [
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,          // IPv4
  /\b([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/,           // MAC address
  /\b[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\b/, // UUID
  /\bv?\d+\.\d+(\.\d+)+\b/,                            // version strings (1.2.3)
  /\bS[Nn][:\s][A-Z0-9\-]{6,}\b/,                      // serial number
  /\bport\s+\d{2,5}\b/i,                               // port numbers
  /\bhostname[:\s]+\S+/i,                              // hostname declarations
]

// Connector defaults — these connectors produce reference data by default
const REFERENCE_CONNECTORS = new Set(['ninjaone', 'halopsa-asset', 'halopsa-contract'])

function detectReferenceByRegex(content: string): boolean {
  return REFERENCE_PATTERNS.some(p => p.test(content))
}

// ── Extraction schema ─────────────────────────────────────────────────────────

const ExtractionSchema = z.object({
  entities: z.array(z.object({
    name:    z.string(),
    type:    z.enum(['person', 'org', 'product', 'topic', 'place']),
    aliases: z.array(z.string()).default([]),
  })),
  locus:         z.string(),
  is_reference:  z.boolean().default(false),
  reference_type: z.enum(REFERENCE_TYPES).nullable().default(null),
  locigrams: z.array(z.object({
    content:    z.string(),
    confidence: z.number().min(0).max(1),
  })),
})

export type ExtractionResult = z.infer<typeof ExtractionSchema> & {
  isReference:   boolean
  referenceType: typeof REFERENCE_TYPES[number] | null
}

const SYSTEM_PROMPT = `You are a memory extraction assistant. Given text, extract structured memory.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation. Just JSON.

Schema:
{
  "entities": [{ "name": string, "type": "person"|"org"|"product"|"topic"|"place", "aliases": string[] }],
  "locus": string,
  "is_reference": boolean,
  "reference_type": "network_device"|"software"|"configuration"|"service_account"|"contract"|"contact"|null,
  "locigrams": [{ "content": string, "confidence": number }]
}

Rules:
- locus format: "people/name", "business/orgname", "technical/topic", "personal/topic", "project/name"
- locigrams: break into individual facts or events, each standalone and plain language
- confidence: 0.0–1.0 (how certain this fact is)
- aliases: other names or abbreviations for the entity (can be empty array)
- is_reference: true if this describes a STABLE FACT ABOUT A THING (IP address, device model, software version, contract terms, person contact details, config settings). false if this describes an EVENT or RELATIONSHIP (something that happened, a conversation, an observation)
- reference_type: only set if is_reference=true. Pick the most specific type:
    network_device = IP addresses, hostnames, MACs, firewall/switch/router configs
    software = app versions, license counts, install states
    configuration = settings, policies, thresholds, baselines
    service_account = usernames, roles, permissions (NOT passwords or secrets)
    contract = SLA terms, renewal dates, pricing, agreement terms
    contact = person phone/email/role/org details`

function fallback(raw: RawMemory, isReference = false): ExtractionResult {
  return {
    entities:      [],
    locus:         'personal/general',
    is_reference:  isReference,
    reference_type: null,
    isReference,
    referenceType: null,
    locigrams:     [{ content: raw.content, confidence: 0.5 }],
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

  // Signal 1: connector default (NinjaOne devices, HaloPSA assets/contracts = reference by default)
  const connectorIsReference = REFERENCE_CONNECTORS.has(raw.metadata?.connector as string ?? '')

  // Signal 2: regex pre-check on content
  const regexIsReference = detectReferenceByRegex(raw.content)

  try {
    const res = await fetch(`${role.url}/chat/completions`, {
      method:  'POST',
      headers: authHeaders(role),
      body: JSON.stringify({
        model: role.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: role.noThink ? `${raw.content}\n/no_think` : raw.content },
        ],
        temperature: 0.1,
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.warn(`[pipeline] extraction LLM error: ${res.status} ${errBody.slice(0, 300)}`)
      return fallback(raw, connectorIsReference || regexIsReference)
    }

    const bodyText = await res.text()
    let data: { choices?: Array<{ message?: { content?: string } }> } = {}

    try {
      data = JSON.parse(bodyText)
    } catch (e) {
      console.warn('[pipeline] LLM returned non-JSON:', bodyText.slice(0, 300))
      return fallback(raw, connectorIsReference || regexIsReference)
    }

    const content = data?.choices?.[0]?.message?.content
    if (!content) return fallback(raw, connectorIsReference || regexIsReference)

    // Strip <think> blocks and code fences
    let cleanJson = content
      .replace(/```json\n?|```/g, '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim()

    // Grab JSON object body if surrounded by text
    const start = cleanJson.indexOf('{')
    const end   = cleanJson.lastIndexOf('}')
    if (start >= 0 && end > start) cleanJson = cleanJson.slice(start, end + 1)

    try {
      const parsed = ExtractionSchema.safeParse(JSON.parse(cleanJson))
      if (!parsed.success) {
        console.warn('[pipeline] extraction schema mismatch:', parsed.error.message)
        return fallback(raw, connectorIsReference || regexIsReference)
      }

      // Signal 3: LLM flag. Any signal = reference.
      const isRef = parsed.data.is_reference || connectorIsReference || regexIsReference

      return {
        ...parsed.data,
        is_reference:  isRef,
        isReference:   isRef,
        referenceType: isRef ? (parsed.data.reference_type ?? null) : null,
      }
    } catch (e) {
      console.warn('[pipeline] JSON parse failed for content:', content)
      return fallback(raw, connectorIsReference || regexIsReference)
    }
  } catch (err) {
    console.warn('[pipeline] extraction failed:', err)
    return fallback(raw, connectorIsReference || regexIsReference)
  }
}
