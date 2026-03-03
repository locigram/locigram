import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface GmailConnectorConfig {
  clientId:     string
  clientSecret: string
  refreshToken: string
  /** Gmail user (default: 'me') */
  userId?: string
  /** Max emails per pull (default 100) */
  limit?: number
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API_BASE  = 'https://gmail.googleapis.com/gmail/v1'

let cachedToken = ''
let tokenExpiry  = 0

async function getAccessToken(config: GmailConnectorConfig): Promise<string> {
  if (cachedToken && tokenExpiry > Date.now() + 60_000) return cachedToken

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type:    'refresh_token',
    }),
  })

  if (!res.ok) throw new Error(`Gmail OAuth failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = data.access_token
  tokenExpiry  = Date.now() + data.expires_in * 1000
  return cachedToken
}

async function gmailGet(token: string, path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Gmail API error: ${res.status} ${path}`)
  return res.json()
}

function buildQuery(since?: Date): string {
  const parts: string[] = ['in:inbox']
  if (since) {
    // Gmail query format: after:YYYY/MM/DD
    const d = since
    parts.push(`after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`)
  }
  return parts.join(' ')
}

function decodeBase64(encoded: string): string {
  try {
    return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
  } catch { return '' }
}

function extractBody(payload: any): string {
  if (payload?.body?.data) return decodeBase64(payload.body.data)
  if (payload?.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64(part.body.data)
      }
    }
    for (const part of payload.parts) {
      const found = extractBody(part)
      if (found) return found
    }
  }
  return ''
}

export function createGmailConnector(config: GmailConnectorConfig): ConnectorPlugin {
  const userId = config.userId ?? 'me'
  const limit  = config.limit ?? 100

  return {
    name: 'gmail',

    validate(cfg: unknown): cfg is GmailConnectorConfig {
      return (
        typeof cfg === 'object' && cfg !== null &&
        'clientId' in cfg && 'clientSecret' in cfg && 'refreshToken' in cfg
      )
    },

    async pull(since?: Date): Promise<RawMemory[]> {
      const token   = await getAccessToken(config)
      const results: RawMemory[] = []
      const q       = buildQuery(since)

      // List message IDs
      const list = await gmailGet(token, `/users/${userId}/messages`, {
        q,
        maxResults: String(limit),
      }) as any

      const msgs = list.messages ?? []
      if (msgs.length === 0) return results

      // Fetch each message in full (format=metadata for speed)
      for (const { id } of msgs) {
        try {
          const msg = await gmailGet(token, `/users/${userId}/messages/${id}`, {
            format: 'full',
          }) as any

          const headers = msg.payload?.headers ?? []
          const get     = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

          const from    = get('From')
          const subject = get('Subject')
          const date    = get('Date')
          const body    = extractBody(msg.payload).slice(0, 1500)
          const dateObj = date ? new Date(date) : new Date(parseInt(msg.internalDate))

          if (!subject && !body) continue

          results.push({
            content:    `Email from ${from}: ${subject}\n\n${body}`.trim(),
            sourceType: 'email' as const,
            sourceRef:  `gmail:email:${id}`,
            occurredAt: dateObj,
            metadata:   {
              sender:    from,
              subject,
              gmailId:   id,
              connector: 'gmail',
            },
          })
        } catch (err) {
          console.warn(`[gmail] failed to fetch message ${id}:`, err)
        }
      }

      return results
    },
  }
}
