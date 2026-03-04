import { graphGet } from './auth'
import type { RawMemory } from '@locigram/core'

export interface TeamsChannel {
  teamId:    string
  channelId: string
  label?:    string   // human-readable name (e.g. "Acme Corp - Support")
}

// A thread is "cold" (done) if no messages in the last 2 hours
// Prevents splitting active conversations mid-thread
const THREAD_COLD_HOURS = 2

// Minimum total words across a thread to be worth extracting
// Short threads (ping-pong one-liners) → skip
const MIN_THREAD_WORDS = 20

// Max thread content length sent to LLM
const MAX_THREAD_CHARS = 3000

interface TeamsMessage {
  id:              string
  replyToId?:      string   // null = thread root; non-null = reply in thread
  sender:          string
  senderEmail?:    string
  content:         string
  createdDateTime: Date
  importance:      string
  hasAttachments:  boolean
}

export async function pullTeamsMessages(
  token:    string,
  channels: TeamsChannel[],
  since?:   Date,
): Promise<RawMemory[]> {
  const results: RawMemory[] = []

  for (const ch of channels) {
    const messages = await fetchChannelMessages(token, ch, since)
    const threads  = groupIntoThreads(messages)

    for (const thread of threads) {
      const memory = threadToMemory(thread, ch)
      if (memory) results.push(memory)
    }
  }

  return results
}

// ── Message fetching ──────────────────────────────────────────────────────────

async function fetchChannelMessages(
  token:   string,
  ch:      TeamsChannel,
  since?:  Date,
): Promise<TeamsMessage[]> {
  const messages: TeamsMessage[] = []

  // Fetch thread roots (top-level messages)
  let url: string | null = buildUrl(ch, since)
  while (url) {
    const data  = await graphGet(token, url) as any
    const items = (data.value ?? []) as any[]

    for (const msg of items) {
      if (msg.messageType !== 'message') continue
      const parsed = parseMessage(msg)
      if (!parsed) continue
      messages.push(parsed)

      // Fetch replies for this thread root
      if (msg.replies?.['@odata.count'] > 0 || msg.replyCount > 0) {
        const replies = await fetchReplies(token, ch, msg.id, since)
        messages.push(...replies)
      }
    }

    url = data['@odata.nextLink'] ?? null
  }

  return messages
}

async function fetchReplies(
  token:     string,
  ch:        TeamsChannel,
  messageId: string,
  since?:    Date,
): Promise<TeamsMessage[]> {
  const url = `https://graph.microsoft.com/v1.0/teams/${ch.teamId}/channels/${ch.channelId}/messages/${messageId}/replies?$top=50`
  const data = await graphGet(token, url) as any
  const msgs: TeamsMessage[] = []

  for (const msg of (data.value ?? []) as any[]) {
    if (msg.messageType !== 'message') continue
    const parsed = parseMessage(msg)
    if (parsed) msgs.push({ ...parsed, replyToId: messageId })
  }

  return msgs
}

function parseMessage(msg: any): TeamsMessage | null {
  const body    = msg.body?.content ?? ''
  const content = stripHtml(body).trim()
  if (!content) return null

  const sender = msg.from?.user?.displayName
    ?? msg.from?.user?.userPrincipalName
    ?? 'Unknown'

  return {
    id:              msg.id,
    replyToId:       msg.replyToId ?? undefined,
    sender,
    senderEmail:     msg.from?.user?.userPrincipalName,
    content,
    createdDateTime: new Date(msg.createdDateTime),
    importance:      msg.importance ?? 'normal',
    hasAttachments:  (msg.attachments?.length ?? 0) > 0,
  }
}

// ── Thread grouping ───────────────────────────────────────────────────────────

interface Thread {
  rootId:    string
  messages:  TeamsMessage[]
  lastAt:    Date
  firstAt:   Date
}

function groupIntoThreads(messages: TeamsMessage[]): Thread[] {
  const threads = new Map<string, Thread>()

  // Sort chronologically first
  messages.sort((a, b) => a.createdDateTime.getTime() - b.createdDateTime.getTime())

  for (const msg of messages) {
    const rootId = msg.replyToId ?? msg.id   // replies share root's ID

    if (!threads.has(rootId)) {
      threads.set(rootId, {
        rootId,
        messages: [],
        lastAt:   msg.createdDateTime,
        firstAt:  msg.createdDateTime,
      })
    }

    const thread = threads.get(rootId)!
    thread.messages.push(msg)
    if (msg.createdDateTime > thread.lastAt) thread.lastAt = msg.createdDateTime
    if (msg.createdDateTime < thread.firstAt) thread.firstAt = msg.createdDateTime
  }

  const cutoff   = new Date(Date.now() - THREAD_COLD_HOURS * 60 * 60 * 1000)
  const filtered = [...threads.values()].filter(t => {
    // Skip threads still active (last message too recent)
    if (t.lastAt > cutoff) return false

    // Skip low-content threads (pure reactions, one-liners)
    const totalWords = t.messages.reduce((sum, m) => sum + m.content.split(/\s+/).length, 0)
    if (totalWords < MIN_THREAD_WORDS) return false

    return true
  })

  return filtered
}

// ── Thread → RawMemory ────────────────────────────────────────────────────────

function threadToMemory(thread: Thread, ch: TeamsChannel): RawMemory | null {
  if (thread.messages.length === 0) return null

  // Build conversation transcript for LLM extraction
  const transcript = thread.messages
    .map(m => {
      const time = m.createdDateTime.toISOString().slice(0, 16).replace('T', ' ')
      return `[${m.sender}, ${time}] ${m.content}`
    })
    .join('\n')
    .slice(0, MAX_THREAD_CHARS)

  const participantNames = [...new Set(thread.messages.map(m => m.sender))].join(', ')
  const hasHighImportance = thread.messages.some(m => m.importance === 'high' || m.importance === 'urgent')
  const hasAttachments    = thread.messages.some(m => m.hasAttachments)

  // sourceRef = thread root ID — entire thread deduplicates as one unit
  return {
    content:    transcript,
    sourceType: 'chat',
    sourceRef:  `m365:teams:thread:${thread.rootId}`,
    occurredAt: thread.firstAt,
    metadata: {
      connector:        'microsoft365',
      channel:          ch.label ?? ch.channelId,
      team_id:          ch.teamId,
      channel_id:       ch.channelId,
      thread_id:        thread.rootId,
      message_count:    thread.messages.length,
      participants:     [...new Set(thread.messages.map(m => m.sender))],
      participant_list: participantNames,
      first_message_at: thread.firstAt.toISOString(),
      last_message_at:  thread.lastAt.toISOString(),
      has_attachments:  hasAttachments,
      importance:       hasHighImportance ? 'high' : 'normal',
    },
  }
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildUrl(ch: TeamsChannel, since: Date | undefined): string {
  const base   = `https://graph.microsoft.com/v1.0/teams/${ch.teamId}/channels/${ch.channelId}/messages`
  const params = new URLSearchParams({
    '$top':    '50',
    '$expand': 'replies',
  })
  if (since) params.set('$filter', `createdDateTime gt ${since.toISOString()}`)
  return `${base}?${params}`
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
