import postgres from 'postgres'
import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface SuruDbConnectorConfig {
  /**
   * Connection string to Andrew's suru Postgres DB on your-server.
   * Default: postgresql://surubot:...@localhost:5432/suru
   */
  connectionString: string

  /**
   * Which suru DB tables/schemas to pull from.
   * Defaults pull from emails + halo tickets + teams messages.
   */
  sources?: Array<'emails' | 'halo_tickets' | 'teams_messages' | 'observations' | 'lessons'>
}

type SourceType = SuruDbConnectorConfig['sources'] extends Array<infer T> ? T : never

// ── Query definitions per source ─────────────────────────────────────────────

async function pullEmails(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT message_id, subject, body_text, sender_email, received_at
        FROM comms.emails
        WHERE received_at > ${since}
        ORDER BY received_at ASC
        LIMIT 500`
    : await sql`
        SELECT message_id, subject, body_text, sender_email, received_at
        FROM comms.emails
        ORDER BY received_at ASC
        LIMIT 500`

  return rows.map(r => ({
    content:    `Email from ${r.sender_email}: ${r.subject}\n\n${r.body_text ?? ''}`.trim(),
    sourceType: 'email' as const,
    sourceRef:  `suru:email:${r.message_id}`,
    occurredAt: new Date(r.received_at),
    metadata:   { sender: r.sender_email, subject: r.subject, connector: 'surudb' },
  }))
}

async function pullHaloTickets(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT id, summary, detail, client_name, status, created_at
        FROM ops.halo_tickets
        WHERE created_at > ${since}
        ORDER BY created_at ASC
        LIMIT 500`
    : await sql`
        SELECT id, summary, detail, client_name, status, created_at
        FROM ops.halo_tickets
        ORDER BY created_at ASC
        LIMIT 500`

  return rows.map(r => ({
    content:    `HaloPSA Ticket #${r.id} [${r.status}] for ${r.client_name}: ${r.summary}\n${r.detail ?? ''}`.trim(),
    sourceType: 'system' as const,
    sourceRef:  `suru:halo:${r.id}`,
    occurredAt: new Date(r.created_at),
    metadata:   { client: r.client_name, status: r.status, ticketId: r.id, connector: 'surudb' },
  }))
}

async function pullTeamsMessages(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT id, content, sender_name, sent_at, channel_name
        FROM comms.teams_messages
        WHERE sent_at > ${since}
        ORDER BY sent_at ASC
        LIMIT 500`
    : await sql`
        SELECT id, content, sender_name, sent_at, channel_name
        FROM comms.teams_messages
        ORDER BY sent_at ASC
        LIMIT 500`

  return rows.map(r => ({
    content:    `Teams message from ${r.sender_name} in ${r.channel_name}: ${r.content}`.trim(),
    sourceType: 'chat' as const,
    sourceRef:  `suru:teams:${r.id}`,
    occurredAt: new Date(r.sent_at),
    metadata:   { sender: r.sender_name, channel: r.channel_name, connector: 'surudb' },
  }))
}

async function pullObservations(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT id, observation, category, source, created_at
        FROM public.observations
        WHERE created_at > ${since}
        ORDER BY created_at ASC
        LIMIT 500`
    : await sql`
        SELECT id, observation, category, source, created_at
        FROM public.observations
        ORDER BY created_at ASC
        LIMIT 500`

  return rows.map(r => ({
    content:    r.observation,
    sourceType: 'system' as const,
    sourceRef:  `suru:observation:${r.id}`,
    occurredAt: new Date(r.created_at),
    metadata:   { category: r.category, source: r.source, connector: 'surudb' },
  }))
}

async function pullLessons(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT id, lesson, context, category, created_at
        FROM public.lessons
        WHERE created_at > ${since}
        ORDER BY created_at ASC
        LIMIT 500`
    : await sql`
        SELECT id, lesson, context, category, created_at
        FROM public.lessons
        ORDER BY created_at ASC
        LIMIT 500`

  return rows.map(r => ({
    content:    `Lesson [${r.category}]: ${r.lesson}${r.context ? `\nContext: ${r.context}` : ''}`,
    sourceType: 'system' as const,
    sourceRef:  `suru:lesson:${r.id}`,
    occurredAt: new Date(r.created_at),
    metadata:   { category: r.category, connector: 'surudb' },
  }))
}

// ── Connector plugin ──────────────────────────────────────────────────────────

export function createSuruDbConnector(config: SuruDbConnectorConfig): ConnectorPlugin {
  const sources = config.sources ?? ['emails', 'halo_tickets', 'teams_messages', 'observations', 'lessons']

  return {
    name: 'surudb',

    validate(cfg: unknown): cfg is SuruDbConnectorConfig {
      return typeof cfg === 'object' && cfg !== null && 'connectionString' in cfg
    },

    async pull(since?: Date): Promise<RawMemory[]> {
      const sql = postgres(config.connectionString, { max: 3, idle_timeout: 30 })
      const results: RawMemory[] = []

      try {
        for (const source of sources) {
          if (source === 'emails')         results.push(...await pullEmails(sql, since))
          if (source === 'halo_tickets')   results.push(...await pullHaloTickets(sql, since))
          if (source === 'teams_messages') results.push(...await pullTeamsMessages(sql, since))
          if (source === 'observations')   results.push(...await pullObservations(sql, since))
          if (source === 'lessons')        results.push(...await pullLessons(sql, since))
        }
      } finally {
        await sql.end()
      }

      return results
    },
  }
}
