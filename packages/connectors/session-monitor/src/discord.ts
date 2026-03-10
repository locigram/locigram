import https from 'node:https'

interface DiscordApiMessage {
  id?: string
  content?: string
  timestamp?: string
  author?: {
    id?: string
    username?: string
    bot?: boolean
  }
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function isoToDiscordSnowflake(sinceIso: string): string {
  const timestampMs = new Date(sinceIso).getTime()
  const discordEpochMs = 1420070400000
  return (BigInt(timestampMs - discordEpochMs) * (2n ** 22n)).toString()
}

function httpGetJson<T>(urlString: string, botToken: string, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'User-Agent': 'locigram-session-monitor/0.1',
        },
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            reject(new Error(`Discord API ${status}: ${raw.slice(0, 300)}`))
            return
          }
          try {
            resolve(JSON.parse(raw) as T)
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    req.end()
  })
}

export async function readDiscordHistory(channelId: string, botToken: string, sinceIso: string, botUserId: string): Promise<string> {
  const messages: DiscordApiMessage[] = []
  let after = isoToDiscordSnowflake(sinceIso)

  while (true) {
    const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=100&after=${encodeURIComponent(after)}`
    const page = await httpGetJson<DiscordApiMessage[]>(url, botToken)
    if (!Array.isArray(page) || page.length === 0) break

    messages.push(...page)
    const lastId = page[page.length - 1]?.id
    if (!lastId) break
    after = lastId
    if (page.length < 100) break
  }

  const lines = messages
    .filter((message) => {
      const author = message.author
      if (!author?.id) return false
      if (author.id === botUserId) return true
      return author.bot !== true
    })
    .sort((a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime())
    .map((message) => {
      const content = (message.content ?? '').trim()
      if (!content) return ''
      return `[${formatTime(new Date(message.timestamp ?? 0))}] [${message.author?.username?.trim() || 'unknown'}]: ${content}`
    })
    .filter(Boolean)

  return lines.join('\n')
}
