import postgres from 'postgres'
import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface M365EmailConnectorConfig {
  /**
   * Postgres connection string to the DB containing comms.emails.
   * For Andrew: postgresql://surubot:...@YOUR_DB_HOST:5432/suru
   */
  connectionString: string

  /** Max emails per pull (default 200 — emails can be large) */
  limit?: number

  /** Only pull emails from these mailboxes (default: all) */
  mailboxes?: string[]

  /** Truncate body_text to this many chars to keep locigrams manageable (default 1500) */
  maxBodyChars?: number
}

// Real schema from sync-email.ts:
// comms.emails: id, conversation_id, subject, from_address, from_name,
//   to_addresses, cc_addresses, body_text, body_preview, received_at,
//   is_read, importance, has_attachments, client_id, folder, mailbox

export function createM365EmailConnector(config: M365EmailConnectorConfig): ConnectorPlugin {
  const maxBody = config.maxBodyChars ?? 1500

  return {
    name: 'm365-email',

    validate(cfg: unknown): cfg is M365EmailConnectorConfig {
      return (
        typeof cfg === 'object' &&
        cfg !== null &&
        'connectionString' in cfg &&
        typeof (cfg as any).connectionString === 'string'
      )
    },

    async pull(since?: Date): Promise<RawMemory[]> {
      const sql   = postgres(config.connectionString, { max: 3, idle_timeout: 30 })
      const limit = config.limit ?? 200

      try {
        const baseQuery = since
          ? sql`
              SELECT id, subject, from_address, from_name, to_addresses,
                     body_text, body_preview, received_at, client_id, mailbox
              FROM comms.emails
              WHERE received_at > ${since}
              ${config.mailboxes?.length ? sql`AND mailbox = ANY(${config.mailboxes})` : sql``}
              ORDER BY received_at ASC
              LIMIT ${limit}`
          : sql`
              SELECT id, subject, from_address, from_name, to_addresses,
                     body_text, body_preview, received_at, client_id, mailbox
              FROM comms.emails
              ${config.mailboxes?.length ? sql`WHERE mailbox = ANY(${config.mailboxes})` : sql``}
              ORDER BY received_at ASC
              LIMIT ${limit}`

        const rows = await baseQuery

        return rows.map(r => {
          const body    = (r.body_text as string | null) ?? (r.body_preview as string | null) ?? ''
          const snippet = body.slice(0, maxBody)

          const content = [
            `Email from ${r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address}`,
            `Subject: ${r.subject}`,
            snippet ? `\n${snippet}` : null,
          ].filter(Boolean).join('\n').trim()

          return {
            content,
            sourceType: 'email' as const,
            sourceRef:  `m365:email:${r.id}`,
            occurredAt: new Date(r.received_at),
            metadata:   {
              sender:    r.from_address,
              senderName: r.from_name,
              subject:   r.subject,
              clientId:  r.client_id,
              mailbox:   r.mailbox,
              connector: 'm365-email',
            },
          }
        })
      } finally {
        await sql.end()
      }
    },
  }
}
