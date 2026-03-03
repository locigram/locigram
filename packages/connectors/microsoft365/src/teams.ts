import { graphGet } from './auth'
import type { RawMemory } from '@locigram/core'

export interface TeamsChannel {
  teamId:    string
  channelId: string
  label?:    string  // human-readable name for context
}

export async function pullTeamsMessages(
  token:    string,
  channels: TeamsChannel[],
  since?:   Date,
): Promise<RawMemory[]> {
  const results: RawMemory[] = []

  for (const ch of channels) {
    let url: string | null = buildUrl(ch, since)

    while (url) {
      const data  = await graphGet(token, url) as any
      const items = (data.value ?? []) as any[]

      for (const msg of items) {
        // Skip system messages and deleted content
        if (msg.messageType !== 'message') continue
        if (!msg.body?.content) continue

        const sender  = msg.from?.user?.displayName ?? msg.from?.user?.userPrincipalName ?? 'unknown'
        const content = stripHtml(msg.body.content).slice(0, 1500)
        if (!content.trim()) continue

        results.push({
          content:    `Teams message from ${sender} in ${ch.label ?? ch.channelId}: ${content}`,
          sourceType: 'chat' as const,
          sourceRef:  `m365:teams:${msg.id}`,
          occurredAt: new Date(msg.createdDateTime),
          metadata:   {
            sender,
            teamId:    ch.teamId,
            channelId: ch.channelId,
            channel:   ch.label,
            connector: 'microsoft365',
          },
        })
      }

      url = data['@odata.nextLink'] ?? null
    }
  }

  return results
}

function buildUrl(ch: TeamsChannel, since: Date | undefined): string {
  const base   = `https://graph.microsoft.com/v1.0/teams/${ch.teamId}/channels/${ch.channelId}/messages`
  const params = new URLSearchParams({ '$top': '50' })
  if (since) params.set('$filter', `createdDateTime gt ${since.toISOString()}`)
  return `${base}?${params}`
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
}
