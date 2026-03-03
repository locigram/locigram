import postgres from 'postgres'
import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface HaloPSAConnectorConfig {
  /**
   * Postgres connection string to the DB containing sync.halopsa_tickets.
   * For Andrew: postgresql://surubot:...@YOUR_DB_HOST:5432/suru
   */
  connectionString: string

  /** Max tickets per pull (default 200) */
  limit?: number
}

// Real schema from sync-halopsa.ts:
// sync.halopsa_tickets: id, summary, details, status_name, priority_name,
//   client_name, user_name, user_email, agent_name, category_1, date_occurred

export const halopsa: ConnectorPlugin = {
  name: 'halopsa',

  validate(config: unknown): config is HaloPSAConnectorConfig {
    return (
      typeof config === 'object' &&
      config !== null &&
      'connectionString' in config &&
      typeof (config as any).connectionString === 'string'
    )
  },

  async pull(since?: Date): Promise<RawMemory[]> {
    throw new Error('Use createHaloPSAConnector(config).pull() — halopsa requires config')
  },
}

export function createHaloPSAConnector(config: HaloPSAConnectorConfig): ConnectorPlugin {
  return {
    name: 'halopsa',

    validate: halopsa.validate,

    async pull(since?: Date): Promise<RawMemory[]> {
      const sql   = postgres(config.connectionString, { max: 3, idle_timeout: 30 })
      const limit = config.limit ?? 200

      try {
        const rows = since
          ? await sql`
              SELECT id, summary, details, status_name, priority_name,
                     client_name, user_name, user_email, agent_name,
                     category_1, date_occurred
              FROM sync.halopsa_tickets
              WHERE date_occurred > ${since}
              ORDER BY date_occurred ASC
              LIMIT ${limit}`
          : await sql`
              SELECT id, summary, details, status_name, priority_name,
                     client_name, user_name, user_email, agent_name,
                     category_1, date_occurred
              FROM sync.halopsa_tickets
              ORDER BY date_occurred ASC
              LIMIT ${limit}`

        return rows.map(r => {
          const lines = [
            `HaloPSA Ticket #${r.id} [${r.status_name} / ${r.priority_name}]`,
            `Client: ${r.client_name}`,
            r.user_name   ? `User: ${r.user_name} <${r.user_email ?? ''}>` : null,
            r.agent_name  ? `Agent: ${r.agent_name}` : null,
            r.category_1  ? `Category: ${r.category_1}` : null,
            `Summary: ${r.summary}`,
            r.details     ? `\n${(r.details as string).slice(0, 1500)}` : null,
          ].filter(Boolean)

          return {
            content:    lines.join('\n').trim(),
            sourceType: 'system' as const,
            sourceRef:  `halopsa:ticket:${r.id}`,
            occurredAt: new Date(r.date_occurred),
            metadata:   {
              ticketId: r.id,
              client:   r.client_name,
              status:   r.status_name,
              priority: r.priority_name,
              connector: 'halopsa',
            },
          }
        })
      } finally {
        await sql.end()
      }
    },
  }
}
