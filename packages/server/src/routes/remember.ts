import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { locigrams, sources } from '@locigram/db'


const schema = z.object({
  content:    z.string().min(1),
  sourceType: z.enum(['email','chat','sms','llm-session','manual','system','webhook','enrichment']).default('manual'),
  sourceRef:  z.string().optional(),
  locus:      z.string().default('personal/general'),
  entities:   z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1.0),
  metadata:   z.record(z.string(), z.unknown()).default({}),
  connector:  z.string().optional(),
  rawUrl:     z.string().optional(),
  // Structured fields (Phase 2.6)
  subject:          z.string().optional(),
  predicate:        z.string().optional(),
  object_val:       z.string().optional(),
  durability_class: z.enum(['permanent', 'stable', 'active', 'session', 'checkpoint']).optional(),
  category:         z.enum(['decision', 'preference', 'fact', 'lesson', 'entity', 'observation', 'convention', 'checkpoint']).optional(),
  importance:       z.enum(['low', 'normal', 'high']).optional(),
})

export const rememberRoute = new Hono()

rememberRoute.post('/', zValidator('json', schema), async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const body = c.req.valid('json')

  const [locigram] = await db.insert(locigrams).values({
    content:         body.content,
    sourceType:      body.sourceType,
    sourceRef:       body.sourceRef,
    locus:           body.locus,
    entities:        body.entities,
    confidence:      body.confidence,
    metadata:        body.metadata,
    subject:         body.subject ?? null,
    predicate:       body.predicate ?? null,
    objectVal:       body.object_val ?? null,
    durabilityClass: body.durability_class ?? 'active',
    category:        body.category ?? 'observation',
    importance:      body.importance ?? 'normal',
    palaceId:        palace.id,
  }).returning()

  // Record provenance
  if (body.connector || body.sourceRef) {
    await db.insert(sources).values({
      locigramId: locigram.id,
      connector:  body.connector ?? 'manual',
      rawRef:     body.sourceRef,
      rawUrl:     body.rawUrl,
      palaceId:   palace.id,
    })
  }

  // TODO: queue embedding (async — don't block response)
  // Graph write handled by graph-worker (polls graphSyncedAt IS NULL every 30s)

  return c.json({ id: locigram.id, status: 'stored' }, 201)
})
