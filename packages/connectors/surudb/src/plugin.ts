import postgres from 'postgres'
import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface SuruDbConnectorConfig {
  /**
   * Connection string to Andrew's suru Postgres DB on your-server.
   * Default pulled from SURU_DB_URL env var.
   */
  connectionString: string

  /**
   * Optional: also connect to the memory DB for observations + lessons.
   * Default: same host, database "memory".
   */
  memoryDbUrl?: string

  sources?: Array<'emails' | 'halopsa_tickets' | 'teams_messages' | 'observations' | 'lessons'>
}

// ── Real suru DB schema ───────────────────────────────────────────────────────
// comms.emails columns: id, conversation_id, subject, from_address, from_name,
//   to_addresses, cc_addresses, body_text, body_preview, received_at, is_read,
//   importance, has_attachments, client_id, folder, mailbox
//
// sync.halopsa_tickets columns: id, summary, details, status_id, status_name,
//   tickettype_id, priority_id, priority_name, sla_id, client_id, client_name,
//   site_id, site_name, user_id, user_name, user_email, agent_id, agent_name,
//   category_1, category_2, category_3, source, date_occurred, date_closed,
//   respond_by_date, fix_by_date, response_date, sla_response_state, sla_fix_state, synced_at
//
// memory DB: memory.observations (category, observation, confidence, source, last_confirmed, created_at)
//            memory.lessons      (lesson, context, category, severity, source, created_at)

async function pullEmails(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT id, subject, from_address, from_name, body_text, received_at, client_id
        FROM comms.emails
        WHERE received_at > ${since}
        ORDER BY received_at ASC
        LIMIT 500`
    : await sql`
        SELECT id, subject, from_address, from_name, body_text, received_at, client_id
        FROM comms.emails
        ORDER BY received_at ASC
        LIMIT 500`

  return rows.map(r => ({
    content:    `Email from ${r.from_name ?? r.from_address}: ${r.subject}\n\n${(r.body_text ?? '').slice(0, 2000)}`.trim(),
    sourceType: 'email' as const,
    sourceRef:  `suru:email:${r.id}`,
    occurredAt: new Date(r.received_at),
    metadata:   {
      sender:   r.from_address,
      name:     r.from_name,
      subject:  r.subject,
      clientId: r.client_id,
      connector: 'surudb',
    },
  }))
}

async function pullHalopsa(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT id, summary, details, status_name, priority_name, client_name,
               user_name, agent_name, category_1, date_occurred
        FROM sync.halopsa_tickets
        WHERE date_occurred > ${since}
        ORDER BY date_occurred ASC
        LIMIT 500`
    : await sql`
        SELECT id, summary, details, status_name, priority_name, client_name,
               user_name, agent_name, category_1, date_occurred
        FROM sync.halopsa_tickets
        ORDER BY date_occurred ASC
        LIMIT 500`

  return rows.map(r => {
    const parts = [
      `HaloPSA Ticket #${r.id} [${r.status_name}/${r.priority_name}]`,
      `Client: ${r.client_name}`,
      r.user_name  ? `User: ${r.user_name}`   : null,
      r.agent_name ? `Agent: ${r.agent_name}` : null,
      r.category_1 ? `Category: ${r.category_1}` : null,
      `Summary: ${r.summary}`,
      r.details    ? `\n${(r.details as string).slice(0, 1000)}` : null,
    ].filter(Boolean)

    return {
      content:    parts.join('\n').trim(),
      sourceType: 'system' as const,
      sourceRef:  `suru:halo:${r.id}`,
      occurredAt: new Date(r.date_occurred),
      metadata:   {
        client:   r.client_name,
        status:   r.status_name,
        priority: r.priority_name,
        ticketId: r.id,
        connector: 'surudb',
      },
    }
  })
}

async function pullObservations(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT id, observation, category, source, created_at
        FROM memory.observations
        WHERE created_at > ${since}
        ORDER BY created_at ASC
        LIMIT 500`
    : await sql`
        SELECT id, observation, category, source, created_at
        FROM memory.observations
        ORDER BY created_at ASC
        LIMIT 500`

  return rows.map(r => ({
    content:    r.observation as string,
    sourceType: 'system' as const,
    sourceRef:  `memory:observation:${r.id}`,
    occurredAt: new Date(r.created_at),
    metadata:   { category: r.category, source: r.source, connector: 'surudb-memory' },
  }))
}

async function pullLessons(sql: ReturnType<typeof postgres>, since?: Date): Promise<RawMemory[]> {
  const rows = since
    ? await sql`
        SELECT id, lesson, context, category, severity, created_at
        FROM memory.lessons
        WHERE created_at > ${since}
        ORDER BY created_at ASC
        LIMIT 500`
    : await sql`
        SELECT id, lesson, context, category, severity, created_at
        FROM memory.lessons
        ORDER BY created_at ASC
        LIMIT 500`

  return rows.map(r => ({
    content:    `Lesson [${r.category}/${r.severity}]: ${r.lesson}${r.context ? `\nContext: ${r.context}` : ''}`,
    sourceType: 'system' as const,
    sourceRef:  `memory:lesson:${r.id}`,
    occurredAt: new Date(r.created_at),
    metadata:   { category: r.category, severity: r.severity, connector: 'surudb-memory' },
  }))
}

// ── Connector plugin ──────────────────────────────────────────────────────────

export function createSuruDbConnector(config: SuruDbConnectorConfig): ConnectorPlugin {
  const sources = config.sources ?? ['emails', 'halopsa_tickets', 'observations', 'lessons']

  return {
    name: 'surudb',

    validate(cfg: unknown): cfg is SuruDbConnectorConfig {
      return typeof cfg === 'object' && cfg !== null && 'connectionString' in cfg
    },

    async pull(since?: Date): Promise<RawMemory[]> {
      const suruSql   = postgres(config.connectionString, { max: 3, idle_timeout: 30 })
      // memory DB — same host, different database
      const memoryUrl = config.memoryDbUrl
        ?? config.connectionString.replace(/\/\w+$/, '/memory')
      const memorySql = postgres(memoryUrl, { max: 3, idle_timeout: 30 })
      const results: RawMemory[] = []

      try {
        if (sources.includes('emails'))          results.push(...await pullEmails(suruSql, since))
        if (sources.includes('halopsa_tickets')) results.push(...await pullHalopsa(suruSql, since))
        if (sources.includes('observations'))    results.push(...await pullObservations(memorySql, since))
        if (sources.includes('lessons'))         results.push(...await pullLessons(memorySql, since))
      } finally {
        await suruSql.end()
        await memorySql.end()
      }

      return results
    },
  }
}
