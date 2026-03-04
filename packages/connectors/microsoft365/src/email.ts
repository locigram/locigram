import { graphGet } from './auth'
import type { RawMemory } from '@locigram/core'
import type { DB } from '@locigram/db'
import { getCursor, setCursor } from '@locigram/db'
import { shouldSkipEmail } from './filters'

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

const BATCH_SIZE    = Number(process.env.LOCIGRAM_M365_EMAIL_BATCH_SIZE)    || 50
const BACKFILL_DAYS = Number(process.env.LOCIGRAM_M365_EMAIL_BACKFILL_DAYS) || 90

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

function normalizeImportance(raw?: string): 'low' | 'normal' | 'high' {
  if (!raw) return 'normal'
  const v = raw.toLowerCase()
  if (v === 'high' || v === 'urgent' || v === 'critical') return 'high'
  if (v === 'low') return 'low'
  return 'normal'
}

export interface EmailBatchConfig {
  db:       DB
  palaceId: string
}

export async function pullEmails(
  token:     string,
  mailboxes: string[],
  since?:    Date,
  limit      = 100,
  batch?:    EmailBatchConfig,
): Promise<RawMemory[]> {
  const results: RawMemory[] = []
  const batchSize = batch ? BATCH_SIZE : limit

  for (const mailbox of mailboxes) {
    // Resolve start cursor
    let startDate = since

    if (batch) {
      const saved = await getCursor(batch.db, batch.palaceId, 'm365-email')
      if (saved) {
        startDate = new Date(saved)
      } else if (!since) {
        startDate = new Date(Date.now() - BACKFILL_DAYS * 86_400_000)
      }
    }

    const url = buildUrl(mailbox, startDate, batchSize)
    const data  = await graphGet(token, url) as any
    const items = (data.value ?? []) as any[]

    let lastReceivedAt: string | null = null

    for (const msg of items) {
      if (msg.isDraft) continue

      const from         = msg.from?.emailAddress
      const senderAddr   = from?.address ?? ''
      const senderName   = from?.name ?? ''
      const toAddresses  = extractAddresses(msg.toRecipients)
      const toNames      = extractNames(msg.toRecipients)
      const ccAddresses  = extractAddresses(msg.ccRecipients)
      const body         = msg.body?.content ?? msg.bodyPreview ?? ''
      const snippet      = stripHtml(body).slice(0, 2000)

      // Apply noise filters
      const filterResult = shouldSkipEmail({
        sender:     senderAddr,
        subject:    msg.subject,
        bodyText:   snippet,
        isDraft:    msg.isDraft,
        categories: msg.categories,
      })
      if (filterResult.skip) continue

      // Human-readable content (no HTML)
      const content = [
        `From: ${senderName || senderAddr}${senderAddr ? ` <${senderAddr}>` : ''}`,
        `To: ${toNames.join(', ')}`,
        `Subject: ${msg.subject}`,
        `Date: ${msg.receivedDateTime}`,
        '',
        snippet,
      ].join('\n').trim()

      // Collect entity names for preClassified
      const entityNames = [senderName, ...toNames].filter(Boolean)

      results.push({
        content,
        sourceType: 'email',
        sourceRef:  `m365:email:${msg.id}`,
        occurredAt: new Date(msg.receivedDateTime),

        preClassified: {
          locus:            'business/email',
          entities:         entityNames,
          isReference:      false,
          referenceType:    undefined,
          importance:       normalizeImportance(msg.importance),
          clientId:         undefined,
          clusterCandidate: true,
        },

        metadata: {
          connector:       'microsoft365',
          mailbox,

          sender:          senderAddr,
          sender_name:     senderName,

          to:              toAddresses,
          to_names:        toNames,
          cc:              ccAddresses,
          bcc:             extractAddresses(msg.bccRecipients),

          subject:         msg.subject,
          body_preview:    msg.bodyPreview,
          importance:      msg.importance,
          has_attachments: msg.hasAttachments,
          is_read:         msg.isRead,
          categories:      msg.categories ?? [],

          conversation_id: msg.conversationId,

          received_at:     msg.receivedDateTime,
          sent_at:         msg.sentDateTime,

          flag_status:     msg.flag?.flagStatus,
        },
      })

      lastReceivedAt = msg.receivedDateTime
    }

    // In batch mode: do NOT follow @odata.nextLink — process one page per sync run
    // Update cursor to last email's receivedDateTime
    if (batch && lastReceivedAt) {
      await setCursor(batch.db, batch.palaceId, 'm365-email', lastReceivedAt)
    }
  }

  if (batch) {
    console.log(`[m365-email] batch: ${results.length} emails, cursor: ${results.length > 0 ? results[results.length - 1].occurredAt?.toISOString() : 'unchanged'}`)
  }

  return results
}

function buildUrl(mailbox: string, since: Date | undefined, limit: number): string {
  const params = new URLSearchParams({
    '$select':  SELECT,
    '$top':     String(Math.min(limit, 100)),
    '$orderby': 'receivedDateTime ASC',
  })

  if (since) {
    params.set('$filter', `receivedDateTime ge ${since.toISOString()} and isDraft eq false`)
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
