import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { locigrams } from '@locigram/db'
import { eq, and } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'

const schema = z.object({
  locigramId: z.string().uuid(),
  action:     z.enum(['correct', 'reinforce', 'expire']),
  correction: z.string().optional(), // new content if action = 'correct'
})

export const feedbackRoute = new Hono()

feedbackRoute.post('/', zValidator('json', schema), async (c) => {
  const db = c.get('db')
  const palace = c.get('palace')
  const { locigramId, action, correction } = c.req.valid('json')

  const [locigram] = await db
    .select()
    .from(locigrams)
    .where(and(eq(locigrams.id, locigramId), eq(locigrams.palaceId, palace.id)))
    .limit(1)

  if (!locigram) throw new HTTPException(404, { message: 'Locigram not found' })

  if (action === 'reinforce') {
    await db.update(locigrams)
      .set({ confidence: Math.min(1.0, locigram.confidence + 0.1) })
      .where(eq(locigrams.id, locigramId))
  }

  if (action === 'expire') {
    await db.update(locigrams)
      .set({ expiresAt: new Date() })
      .where(eq(locigrams.id, locigramId))
  }

  if (action === 'correct' && correction) {
    // Locigrams are immutable — store a correction as a new locigram
    await db.insert(locigrams).values({
      content:    correction,
      sourceType: 'manual',
      sourceRef:  locigramId,  // links back to original
      locus:      locigram.locus,
      entities:   locigram.entities,
      confidence: 1.0,
      metadata:   { corrects: locigramId },
      palaceId:   palace.id,
    })
  }

  return c.json({ status: 'ok', action })
})
