import { locigrams } from '@locigram/db'
import { eq, and, sql } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import type { PipelineConfig } from './config'

export async function runNoiseAssessment(db: DB, palaceId: string, config: PipelineConfig): Promise<void> {
  console.log(`[assess][${palaceId}] starting noise re-assessment`)

  // Find locigrams queued for assessment
  const candidates = await db
    .select()
    .from(locigrams)
    .where(
      and(
        eq(locigrams.palaceId, palaceId),
        sql`metadata->>'assess_queued' = 'true'`,
      )
    )
    .limit(50)  // batch cap — don't hammer the LLM

  if (candidates.length === 0) {
    console.log(`[assess][${palaceId}] no candidates`)
    return
  }

  console.log(`[assess][${palaceId}] assessing ${candidates.length} candidates`)

  const { url, model, apiKey, noThink } = config.llm.extract

  let expired = 0
  let kept = 0

  for (const loc of candidates) {
    const prompt = `You are evaluating a memory unit for a personal AI assistant. Determine if this memory is useful for future context recall.

Memory: "${loc.content}"
Source type: ${loc.sourceType}
Connector: ${loc.connector ?? 'unknown'}

Reply with ONLY a JSON object: { "useful": true|false, "reason": "one sentence" }

A memory is NOT useful if it is:
- Spam, marketing, or promotional content
- An automated notification with no context (e.g. "Your package has shipped")
- A one-liner chat message with no information content (e.g. "ok", "sounds good")
- A code snippet with no surrounding context about what it does or why
- Calendar accept/decline notifications

A memory IS useful if it contains:
- Facts about people, organizations, or relationships
- Decisions, commitments, or outcomes
- Technical configurations or system states
- Financial or operational information`

    try {
      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: noThink ? prompt + ' /no_think' : prompt }],
          max_tokens: 100,
        }),
      })

      const text = await res.text()
      const body = JSON.parse(text)
      const content = body.choices?.[0]?.message?.content ?? ''

      // Strip think tags
      const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      const first = cleaned.indexOf('{')
      const last  = cleaned.lastIndexOf('}')
      if (first === -1 || last === -1) throw new Error('no JSON in response')

      const result = JSON.parse(cleaned.slice(first, last + 1)) as { useful: boolean; reason: string }

      if (!result.useful) {
        // Expire confirmed noise
        await db.update(locigrams)
          .set({
            expiresAt: new Date(),
            metadata:  sql`metadata - 'assess_queued' || jsonb_build_object('assess_result', 'noise', 'assess_reason', ${result.reason})`,
          })
          .where(eq(locigrams.id, loc.id))
        expired++
      } else {
        // Keep it — clear queue flag, set score floor
        await db.update(locigrams)
          .set({
            accessScore: 0.1,  // floor — prevent re-queuing immediately
            metadata:    sql`metadata - 'assess_queued' || jsonb_build_object('assess_result', 'kept', 'assess_reason', ${result.reason})`,
          })
          .where(eq(locigrams.id, loc.id))
        kept++
      }
    } catch (err) {
      // Clear queue flag on error to prevent infinite retry
      await db.update(locigrams)
        .set({ metadata: sql`metadata - 'assess_queued'` })
        .where(eq(locigrams.id, loc.id))
      console.warn(`[assess] failed on ${loc.id}:`, err)
    }
  }

  console.log(`[assess][${palaceId}] done — expired: ${expired}, kept: ${kept}`)
}
