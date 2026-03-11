/**
 * discord.ts — Fetch Discord channel message history for session summarization.
 * Handles 429 rate limiting with automatic retry.
 */
import https from 'node:https'

export interface DiscordMessage {
  id: string
  content: string
  authorId: string
  authorUsername: string
  timestamp: string
  isBot: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isoToSnowflake(isoString: string): string {
  const ms = BigInt(new Date(isoString).getTime())
  return ((ms - 1420070400000n) * (2n ** 22n)).toString()
}

function snowflakeToMs(snowflake: string): number {
  return Number(BigInt(snowflake) >> 22n) + 1420070400000
}

function formatTime(isoString: string): string {
  const d = new Date(isoString)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

interface FetchResult { status: number; body: string }

function httpGet(url: string, headers: Record<string, string>): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers,
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(new Error('Discord API timeout')) })
    req.end()
  })
}

export async function readDiscordHistory(
  channelId: string,
  botToken: string,
  sinceIso: string,
  botUserId: string,
): Promise<string> {
  const headers = {
    Authorization: `Bot ${botToken}`,
    'User-Agent': 'LocigamSessionMonitor/1.0',
  }

  const afterSnowflake = isoToSnowflake(sinceIso)
  const messages: DiscordMessage[] = []
  let lastId = afterSnowflake
  let rateLimitRetries = 0

  for (let page = 0; page < 10; page++) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100&after=${lastId}`

    let result: FetchResult
    try {
      result = await httpGet(url, headers)
    } catch (e: unknown) {
      console.warn(`[discord] fetch error: ${e instanceof Error ? e.message : String(e)}`)
      break
    }

    if (result.status === 429) {
      let retryAfter = 1.0
      try { retryAfter = JSON.parse(result.body).retry_after ?? 1.0 } catch {}
      console.warn(`[discord] rate limited, waiting ${retryAfter}s`)
      await sleep(Math.ceil(retryAfter * 1000) + 200)
      rateLimitRetries++
      if (rateLimitRetries > 5) { console.warn('[discord] too many rate limits, stopping'); break }
      page--  // retry this page
      continue
    }

    if (result.status !== 200) {
      console.warn(`[discord] unexpected response: ${result.status}`)
      break
    }

    let batch: Array<{ id: string; content?: string; author?: { id: string; username: string; bot?: boolean }; timestamp?: string }>
    try { batch = JSON.parse(result.body) } catch { console.warn('[discord] parse error'); break }
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const msg of batch) {
      const content = (msg.content ?? '').trim()
      if (!content) continue
      const authorId = msg.author?.id ?? ''
      const isBot = msg.author?.bot === true
      if (isBot && authorId !== botUserId) continue

      messages.push({
        id: msg.id,
        content,
        authorId,
        authorUsername: msg.author?.username ?? 'unknown',
        timestamp: msg.timestamp ?? new Date(snowflakeToMs(msg.id)).toISOString(),
        isBot,
      })
    }

    const sorted = [...batch].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1))
    lastId = sorted[sorted.length - 1].id
    if (batch.length < 100) break

    await sleep(300)  // pace between pages
  }

  if (messages.length === 0) return ''
  messages.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1))
  return messages.map(m => `[${formatTime(m.timestamp)}] [${m.authorUsername}]: ${m.content}`).join('\n\n')
}

/**
 * Resolve the bot's own user ID via the Discord /users/@me endpoint.
 * Returns null if the token is invalid or the request fails.
 */
export async function resolveBotUserId(token: string): Promise<string | null> {
  try {
    const data = await discordGet<{ id?: string }>('/users/@me', token)
    return data?.id ?? null
  } catch {
    return null
  }
}
