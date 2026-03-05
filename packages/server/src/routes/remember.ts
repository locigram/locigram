import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { locigrams, sources } from '@locigram/db'
import { writeMemoryToGraph, parseAgentFromLocus } from '../graph/graph-write'

const schema = z.object({
  content:    z.string().min(1),
  sourceType: z.enum(['email','chat','sms','llm-session','manual','system','webhook']).default('manual'),
  sourceRef:  z.string().optional(),
  locus:      z.string().default('personal/general'),
  entities:   z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1.0),
  metadata:   z.record(z.unknown()).default({}),
  connector:  z.string().optional(),
  rawUrl:     z.string().optional(),
})

export const rememberRoute = new Hono()

rememberRoute.post('/', zValidator('json', schema), async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const body = c.req.valid('json')

  const [locigram] = await db.insert(locigrams).values({
    content:    body.content,
    sourceType: body.sourceType,
    sourceRef:  body.sourceRef,
    locus:      body.locus,
    entities:   body.entities,
    confidence: body.confidence,
    metadata:   body.metadata,
    palaceId:   palace.id,
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

  // Fire-and-forget graph write (non-blocking — errors logged, never thrown)
  void writeMemoryToGraph({
    id: locigram.id,
    palaceId: palace.id,
    locus: body.locus,
    sourceType: body.sourceType,
    agentName: parseAgentFromLocus(body.locus),
    sessionId: (body.metadata as any)?.session_id ?? (body.metadata as any)?.sessionId ?? undefined,
    importance: null,
    occurredAt: new Date(),
    connector: body.connector ?? null,
  }).catch(e => console.warn('[graph] remember write failed:', e))

  return c.json({ id: locigram.id, status: 'stored' }, 201)
})
