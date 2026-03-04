import type { ConnectorPlugin, RawMemory } from '@locigram/core'
import type { DB } from '@locigram/db'
import { getGraphToken } from './auth'
import { pullEmails } from './email'
import { pullTeamsMessages } from './teams'
import type { TeamsChannel } from './teams'

export interface Microsoft365ConnectorConfig {
  tenantId:     string
  clientId:     string
  clientSecret: string

  /** Mailboxes to pull email from (e.g. ['user@company.com']) */
  mailboxes?: string[]

  /** Teams channels to pull messages from */
  teamsChannels?: TeamsChannel[]

  /** Max emails per mailbox per pull (default 100) */
  emailLimit?: number

  /** DB instance for cursor-based batch mode (optional) */
  db?: DB

  /** Palace ID for cursor-based batch mode (optional) */
  palaceId?: string
}

export function createMicrosoft365Connector(config: Microsoft365ConnectorConfig): ConnectorPlugin {
  return {
    name: 'microsoft365',

    validate(cfg: unknown): cfg is Microsoft365ConnectorConfig {
      return (
        typeof cfg === 'object' && cfg !== null &&
        'tenantId' in cfg && 'clientId' in cfg && 'clientSecret' in cfg
      )
    },

    async pull(since?: Date): Promise<RawMemory[]> {
      const token   = await getGraphToken(config)
      const results: RawMemory[] = []

      if (config.mailboxes?.length) {
        const batch = config.db && config.palaceId
          ? { db: config.db, palaceId: config.palaceId }
          : undefined

        const emails = await pullEmails(
          token,
          config.mailboxes,
          since,
          config.emailLimit ?? 100,
          batch,
        )
        results.push(...emails)
      }

      if (config.teamsChannels?.length) {
        const messages = await pullTeamsMessages(token, config.teamsChannels, since)
        results.push(...messages)
      }

      return results
    },
  }
}
