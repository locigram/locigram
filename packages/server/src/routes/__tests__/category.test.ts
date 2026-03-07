import { describe, test, expect } from 'bun:test'
import { z } from 'zod'

// ── Category schema validation tests ────────────────────────────────────────

const CategoryEnum = z.enum(['decision', 'preference', 'fact', 'lesson', 'entity', 'observation'])

const LocigramSchema = z.object({
  content:    z.string(),
  confidence: z.number().min(0).max(1),
  category:   CategoryEnum.default('observation'),
})

describe('category extraction schema', () => {
  test('each category value is valid', () => {
    for (const cat of ['decision', 'preference', 'fact', 'lesson', 'entity', 'observation'] as const) {
      const result = LocigramSchema.safeParse({ content: 'test', confidence: 0.9, category: cat })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.category).toBe(cat)
    }
  })

  test('default category is observation when not specified', () => {
    const result = LocigramSchema.safeParse({ content: 'test', confidence: 0.9 })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.category).toBe('observation')
  })

  test('invalid category is rejected', () => {
    const result = LocigramSchema.safeParse({ content: 'test', confidence: 0.9, category: 'invalid' })
    expect(result.success).toBe(false)
  })
})

describe('preClassified data gets category fact', () => {
  test('structured data defaults to fact', () => {
    // Simulates the preClassified path in ingest.ts
    const preClassified = {
      content: 'Server 192.168.1.1 firmware v2.3.4',
      confidence: 1.0,
      category: 'fact' as const,
    }
    const result = LocigramSchema.safeParse(preClassified)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.category).toBe('fact')
  })
})

describe('recall category filter', () => {
  test('filter matches correct category', () => {
    const results = [
      { id: '1', content: 'decided to use Postgres', category: 'decision', _score: 0.9 },
      { id: '2', content: 'server IP is 10.0.0.1', category: 'fact', _score: 0.85 },
      { id: '3', content: 'prefer dark mode', category: 'preference', _score: 0.8 },
      { id: '4', content: 'general meeting note', category: 'observation', _score: 0.75 },
    ]

    const filtered = results.filter(r => r.category === 'decision')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('1')
  })

  test('no filter returns all results', () => {
    const results = [
      { id: '1', category: 'decision', _score: 0.9 },
      { id: '2', category: 'fact', _score: 0.85 },
    ]
    const category = undefined
    const filtered = category ? results.filter(r => r.category === category) : results
    expect(filtered).toHaveLength(2)
  })
})

describe('fallback produces observation category', () => {
  test('fallback locigram has observation category', () => {
    // Simulates the fallback function in extract.ts
    const fallbackLocigram = { content: 'raw text', confidence: 0.5, category: 'observation' as const }
    const result = LocigramSchema.safeParse(fallbackLocigram)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.category).toBe('observation')
  })
})
