import { z } from 'zod'
import { locigrams, truths, entities } from '@locigram/db'
import { eq, and, gte, desc, sql } from 'drizzle-orm'
import type { DB } from '@locigram/db'
import type { Palace } from '@locigram/db'

export function buildTools(db: DB, palace: Palace) {
  return {

    memory_recall: {
      description: 'Semantically search memories in the palace. Returns the most relevant locigrams for a given query.',
      schema: z.object({
        query:  z.string().describe('What to search for'),
        locus:  z.string().optional().describe('Namespace filter e.g. people/, business/, project/locigram'),
        limit:  z.number().int().min(1).max(20).default(10).describe('Max results'),
      }),
      handler: async ({ query, locus, limit }: { query: string; locus?: string; limit: number }) => {
        // TODO: replace with Qdrant semantic search
        const results = await db.select().from(locigrams)
          .where(eq(locigrams.palaceId, palace.id))
          .orderBy(desc(locigrams.createdAt))
          .limit(limit)
        return { results, query, note: 'semantic search coming — keyword fallback active' }
      },
    },

    memory_remember: {
      description: 'Store a new memory in the palace.',
      schema: z.object({
        content:    z.string().describe('The memory to store in plain language'),
        locus:      z.string().default('personal/general').describe('Namespace e.g. people/andrew, project/locigram'),
        entities:   z.array(z.string()).default([]).describe('Named entities mentioned'),
        sourceType: z.enum(['manual','llm-session','email','sms','chat','webhook','system']).default('llm-session'),
      }),
      handler: async ({ content, locus, entities: ents, sourceType }: any) => {
        const [loc] = await db.insert(locigrams).values({
          content, locus, entities: ents, sourceType, confidence: 1.0, metadata: {}, palaceId: palace.id,
        }).returning()
        return { id: loc.id, status: 'stored' }
      },
    },

    memory_context: {
      description: 'Surface the most relevant recent memories for the current context.',
      schema: z.object({
        context: z.string().describe('Current topic or task for context'),
        limit:   z.number().int().default(5),
      }),
      handler: async ({ limit }: { context: string; limit: number }) => {
        const results = await db.select().from(locigrams)
          .where(eq(locigrams.palaceId, palace.id))
          .orderBy(desc(locigrams.createdAt))
          .limit(limit)
        return { results }
      },
    },

    people_lookup: {
      description: 'Get a full profile for a person — all memories and facts about them.',
      schema: z.object({
        name: z.string().describe('Person name or alias'),
      }),
      handler: async ({ name }: { name: string }) => {
        const [entity] = await db.select().from(entities)
          .where(and(eq(entities.palaceId, palace.id), eq(entities.name, name)))
          .limit(1)

        const memories = await db.select().from(locigrams)
          .where(and(
            eq(locigrams.palaceId, palace.id),
            sql`${locigrams.entities} @> ARRAY[${name}]::text[]`
          ))
          .orderBy(desc(locigrams.createdAt))
          .limit(20)

        return { entity: entity ?? null, memories, total: memories.length }
      },
    },

    truth_get: {
      description: 'Get high-confidence facts (truths) about a topic or locus.',
      schema: z.object({
        locus:         z.string().optional().describe('Namespace filter'),
        minConfidence: z.number().min(0).max(1).default(0.7),
        limit:         z.number().int().default(10),
      }),
      handler: async ({ minConfidence, limit }: any) => {
        const results = await db.select().from(truths)
          .where(and(eq(truths.palaceId, palace.id), gte(truths.confidence, minConfidence)))
          .orderBy(desc(truths.confidence))
          .limit(limit)
        return { results, total: results.length }
      },
    },

    recent_activity: {
      description: 'Browse recent memories by time window or locus.',
      schema: z.object({
        hours: z.number().int().default(24).describe('Look back window in hours'),
        locus: z.string().optional(),
        limit: z.number().int().default(20),
      }),
      handler: async ({ hours, limit }: { hours: number; locus?: string; limit: number }) => {
        const since = new Date(Date.now() - hours * 60 * 60 * 1000)
        const results = await db.select().from(locigrams)
          .where(and(eq(locigrams.palaceId, palace.id), gte(locigrams.createdAt, since)))
          .orderBy(desc(locigrams.createdAt))
          .limit(limit)
        return { results, since: since.toISOString(), total: results.length }
      },
    },

    palace_stats: {
      description: 'Get stats about this palace — locigram count, truth count, top entities.',
      schema: z.object({}),
      handler: async () => {
        const [{ count: locigramCount }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(locigrams).where(eq(locigrams.palaceId, palace.id))

        const [{ count: truthCount }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(truths).where(eq(truths.palaceId, palace.id))

        return {
          palace: { id: palace.id, name: palace.name },
          stats: { locigramCount, truthCount },
        }
      },
    },
  }
}
