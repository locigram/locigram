import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const schema = z.object({
  suruDbUrl: z.string().optional(),   // defaults to env SURU_DB_URL
  since:     z.string().datetime().optional(),
  dryRun:    z.boolean().default(false),
  sources:   z.array(
    z.enum(['emails', 'halo_tickets', 'teams_messages', 'observations', 'lessons'])
  ).optional(),
})

export const bootstrapRoute = new Hono()

// POST /api/bootstrap/surudb — seed palace from suru DB
bootstrapRoute.post('/surudb', zValidator('json', schema), async (c) => {
  const db             = c.get('db')
  const pipelineConfig = c.get('pipelineConfig')
  const body           = c.req.valid('json')

  const suruDbUrl = body.suruDbUrl ?? process.env.SURU_DB_URL
  if (!suruDbUrl) {
    return c.json({ error: 'SURU_DB_URL not configured' }, 400)
  }

  const { bootstrapFromSuruDb } = await import('@locigram/connector-surudb')
  const result = await bootstrapFromSuruDb(
    { connectionString: suruDbUrl, sources: body.sources },
    db,
    pipelineConfig,
    { since: body.since ? new Date(body.since) : undefined, dryRun: body.dryRun },
  )

  return c.json(result)
})
