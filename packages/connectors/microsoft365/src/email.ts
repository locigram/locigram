import { graphGet } from './auth'
import type { RawMemory } from '@locigram/core'

// All fields we pull from the Graph API per message
const SELECT = [
  'id',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'body',
  'bodyPreview',
  'receivedDateTime',
  'sentDateTime',
  'importance',
  'hasAttachments',
  'conversationId',
  'conversationIndex',
  'isRead',
  'isDraft',
  'categories',
  'flag',
].join(',')

function extractAddresses(recipients: any[]): string[] {
  return (recipients ?? [])
    .map((r: any) => r?.emailAddress?.address)
    .filter(Boolean)
}

function extractNames(recipients: any[]): string[] {
  return (recipients ?? [])
    .map((r: any) => r?.emailAddress?.name || r?.emailAddress?.address)
    .filter(Boolean)
}

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
        // Skip drafts — they're not real communications yet
        if (msg.isDraft) continue

        const from         = msg.from?.emailAddress
        const toAddresses  = extractAddresses(msg.toRecipients)
        const toNames      = extractNames(msg.toRecipients)
        const ccAddresses  = extractAddresses(msg.ccRecipients)
        const body         = msg.body?.content ?? msg.bodyPreview ?? ''
        const snippet      = stripHtml(body).slice(0, 2000)

        // Build human-readable content for LLM extraction
        const content = [
          `Email from ${from?.name ?? from?.address ?? 'unknown'} to ${toNames.join(', ')}`,
          `Subject: ${msg.subject}`,
          ccAddresses.length > 0 ? `CC: ${ccAddresses.join(', ')}` : null,
          '',
          snippet,
        ].filter(Boolean).join('\n').trim()

        results.push({
          content,
          sourceType: 'email',
          sourceRef:  `m365:email:${msg.id}`,

          // When the email was received — this is `occurred_at` in the DB
          occurredAt: new Date(msg.receivedDateTime),

          metadata: {
            // Identity
            connector:       'microsoft365',
            mailbox,                          // which mailbox this came from

            // Sender
            sender:          from?.address,
            sender_name:     from?.name,

            // Recipients
            to:              toAddresses,
            to_names:        toNames,
            cc:              ccAddresses,
            bcc:             extractAddresses(msg.bccRecipients),

            // Message info
            subject:         msg.subject,
            body_preview:    msg.bodyPreview,
            importance:      msg.importance,         // low | normal | high
            has_attachments: msg.hasAttachments,     // boolean
            is_read:         msg.isRead,             // boolean
            categories:      msg.categories ?? [],   // user-defined tags

            // Threading
            conversation_id: msg.conversationId,     // thread grouping key

            // Timestamps
            received_at:     msg.receivedDateTime,   // ISO string (also in occurredAt)
            sent_at:         msg.sentDateTime,        // when sender sent it (may differ from received)

            // Follow-up flag
            flag_status:     msg.flag?.flagStatus,   // notFlagged | flagged | complete
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
    '$top':     String(Math.min(limit, 100)), // Graph API max per page = 1000, but keep batches small
    '$orderby': 'receivedDateTime ASC',
  })

  if (since) {
    params.set('$filter', `receivedDateTime gt ${since.toISOString()} and isDraft eq false`)
  } else {
    params.set('$filter', 'isDraft eq false')
  }

  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?${params}`
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // strip style blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')  // strip script blocks
    .replace(/<[^>]+>/g, ' ')                          // strip tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
