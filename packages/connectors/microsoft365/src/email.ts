import { graphGet } from './auth'
import type { RawMemory } from '@locigram/core'

const SELECT = [
  'id', 'subject', 'from', 'toRecipients',
  'body', 'bodyPreview', 'receivedDateTime', 'importance',
].join(',')

export async function pullEmails(
  token:     string,
  mailboxes: string[],
  since?:    Date,
  limit      = 100,
): Promise<RawMemory[]> {
  const results: RawMemory[] = []

  for (const mailbox of mailboxes) {
    let url: string | null = buildUrl(mailbox, since, limit)

    while (url) {
      const data  = await graphGet(token, url) as any
      const items = (data.value ?? []) as any[]

      for (const msg of items) {
        const from    = msg.from?.emailAddress
        const body    = msg.body?.content ?? msg.bodyPreview ?? ''
        const snippet = stripHtml(body).slice(0, 1500)

        results.push({
          content:    `Email from ${from?.name ?? from?.address ?? 'unknown'}: ${msg.subject}\n\n${snippet}`.trim(),
          sourceType: 'email' as const,
          sourceRef:  `m365:email:${msg.id}`,
          occurredAt: new Date(msg.receivedDateTime),
          metadata:   {
            sender:     from?.address,
            senderName: from?.name,
            subject:    msg.subject,
            mailbox,
            importance: msg.importance,
            connector:  'microsoft365',
          },
        })
      }

      url = data['@odata.nextLink'] ?? null
    }
  }

  return results
}

function buildUrl(mailbox: string, since: Date | undefined, limit: number): string {
  const params = new URLSearchParams({
    '$select':  SELECT,
    '$top':     String(limit),
    '$orderby': 'receivedDateTime ASC',
  })

  if (since) {
    params.set('$filter', `receivedDateTime gt ${since.toISOString()}`)
  }

  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?${params}`
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
}
