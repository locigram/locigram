import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface HaloPSAConnectorConfig {
  /** e.g. https://support.yourcompany.com */
  baseUrl:      string
  clientId:     string
  clientSecret: string
  /** Max tickets per pull (default 200) */
  limit?: number
}

// Token cache
let cachedToken = ''
let tokenExpiry  = 0

async function getToken(config: HaloPSAConnectorConfig): Promise<string> {
  if (cachedToken && tokenExpiry > Date.now() + 60_000) return cachedToken

  const res = await fetch(`${config.baseUrl}/auth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     config.clientId,
      client_secret: config.clientSecret,
      scope:         'all',
    }),
  })

  if (!res.ok) throw new Error(`HaloPSA auth failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = data.access_token
  tokenExpiry  = Date.now() + data.expires_in * 1000
  return cachedToken
}

async function haloGet(token: string, baseUrl: string, path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const url    = new URL(`${baseUrl}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HaloPSA API error: ${res.status} ${path}`)
  return res.json()
}

async function fetchTickets(token: string, config: HaloPSAConnectorConfig, since?: Date): Promise<any[]> {
  const tickets: any[] = []
  const pageSize = 100
  let page = 1

  while (true) {
    const params: Record<string, string | number> = {
      page_no:   page,
      page_size: pageSize,
      pageinate: 'true',
      order:     'dateoccurred',
    }

    if (since) params['dateoccurred_from'] = since.toISOString().split('T')[0]

    const data = await haloGet(token, config.baseUrl, '/api/Tickets', params) as any
    const batch = Array.isArray(data?.tickets) ? data.tickets : []
    if (batch.length === 0) break
    tickets.push(...batch)
    if (batch.length < pageSize) break
    page++
    await new Promise(r => setTimeout(r, 200))  // rate limit courtesy
  }

  return tickets
}

export function createHaloPSAConnector(config: HaloPSAConnectorConfig): ConnectorPlugin {
  return {
    name: 'halopsa',

    validate(cfg: unknown): cfg is HaloPSAConnectorConfig {
      return (
        typeof cfg === 'object' && cfg !== null &&
        'baseUrl' in cfg && 'clientId' in cfg && 'clientSecret' in cfg
      )
    },

    async pull(since?: Date): Promise<RawMemory[]> {
      const token   = await getToken(config)
      const tickets = await fetchTickets(token, config, since)

      return tickets.map(t => {
        const lines = [
          `HaloPSA Ticket #${t.id} [${t.status_name ?? 'open'} / ${t.priority_name ?? 'normal'}]`,
          t.client_name  ? `Client: ${t.client_name}`   : null,
          t.user_name    ? `User: ${t.user_name}`        : null,
          t.agent_name   ? `Agent: ${t.agent_name}`      : null,
          t.category_1   ? `Category: ${t.category_1}`   : null,
          `Summary: ${t.summary}`,
          t.details      ? `\n${String(t.details).slice(0, 1500)}` : null,
        ].filter(Boolean)

        return {
          content:    lines.join('\n').trim(),
          sourceType: 'system' as const,
          sourceRef:  `halopsa:ticket:${t.id}`,
          occurredAt: new Date(t.dateoccurred ?? Date.now()),
          metadata:   {
            ticketId:  t.id,
            client:    t.client_name,
            status:    t.status_name,
            priority:  t.priority_name,
            connector: 'halopsa',
          },
        }
      })
    },
  }
}
