import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { hybridRecall } from '../hybrid-recall'

const schema = z.object({
  query:      z.string().min(1),
  locus:      z.string().optional(),
  connector:  z.string().optional(),
  sourceType: z.string().optional(),
  category:   z.enum(['decision', 'preference', 'fact', 'lesson', 'entity', 'observation', 'convention', 'checkpoint']).optional(),
  subject:    z.string().optional(),
  predicate:  z.string().optional(),
  mode:       z.enum(['auto', 'vector', 'fts', 'structured', 'hybrid']).default('auto'),
  limit:      z.number().int().min(1).max(50).default(10),
  minScore:   z.number().min(0).max(1).default(0),
})

export const recallRoute = new Hono()

recallRoute.post('/', zValidator('json', schema), async (c) => {
  const db           = c.get('db')
  const palace       = c.get('palace')
  const vectorClient = c.get('vectorClient')
  const body = c.req.valid('json')

  const result = await hybridRecall(db, vectorClient, {
    query:      body.query,
    palaceId:   palace.id,
    locus:      body.locus,
    connector:  body.connector,
    sourceType: body.sourceType,
    category:   body.category,
    subject:    body.subject,
    predicate:  body.predicate,
    mode:       body.mode,
    limit:      body.limit,
    minScore:   body.minScore,
  })

  return c.json(result)
})
