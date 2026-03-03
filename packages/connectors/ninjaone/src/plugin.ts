import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface NinjaOneConnectorConfig {
  clientId:     string
  clientSecret: string
  /** Pull sources (default: both) */
  sources?: Array<'devices' | 'alerts'>
}

const API_BASE      = 'https://app.ninjarmm.com/api/v2'
const TOKEN_ENDPOINT = 'https://app.ninjarmm.com/oauth/token'

let cachedToken = ''
let tokenExpiry  = 0

async function getToken(config: NinjaOneConnectorConfig): Promise<string> {
  if (cachedToken && tokenExpiry > Date.now() + 60_000) return cachedToken

  const res = await fetch(TOKEN_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     config.clientId,
      client_secret: config.clientSecret,
      scope:         'monitoring management',
    }),
  })

  if (!res.ok) throw new Error(`NinjaOne auth failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = data.access_token
  tokenExpiry  = Date.now() + data.expires_in * 1000
  return cachedToken
}

async function ninjaGet(token: string, path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`NinjaOne API error: ${res.status} ${path}`)
  return res.json()
}

function extractArray(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload
  if (typeof payload === 'object' && payload !== null) {
    for (const key of ['results', 'data', 'items', 'devices', 'alerts']) {
      const v = (payload as any)[key]
      if (Array.isArray(v)) return v
    }
  }
  return []
}

export function createNinjaOneConnector(config: NinjaOneConnectorConfig): ConnectorPlugin {
  const sources = config.sources ?? ['devices', 'alerts']

  return {
    name: 'ninjaone',

    validate(cfg: unknown): cfg is NinjaOneConnectorConfig {
      return (
        typeof cfg === 'object' && cfg !== null &&
        'clientId' in cfg && 'clientSecret' in cfg
      )
    },

    async pull(since?: Date): Promise<RawMemory[]> {
      const token   = await getToken(config)
      const results: RawMemory[] = []

      if (sources.includes('devices')) {
        const payload = await ninjaGet(token, '/devices', since ? { updatedAfter: since.toISOString() } : {})
        const devices = extractArray(payload)

        for (const d of devices) {
          const name  = d.systemName ?? d.system_name ?? `Device #${d.id}`
          const org   = d.organizationName ?? d.organization_name ?? 'unknown'
          const lines = [
            `NinjaOne Device: ${name}`,
            `Organization: ${org}`,
            d.os?.name    ? `OS: ${d.os.name}`            : null,
            d.lastContact ? `Last contact: ${d.lastContact}` : null,
            d.ipAddresses ? `IPs: ${(d.ipAddresses as string[]).join(', ')}` : null,
          ].filter(Boolean)

          results.push({
            content:    lines.join('\n'),
            sourceType: 'system' as const,
            sourceRef:  `ninjaone:device:${d.id}`,
            occurredAt: new Date(d.lastContact ?? d.lastUpdate ?? Date.now()),
            metadata:   {
              deviceId: d.id,
              org,
              os:       d.os?.name,
              connector: 'ninjaone',
            },
          })
        }
      }

      if (sources.includes('alerts')) {
        const payload = await ninjaGet(token, '/alerts', since ? { after: since.toISOString() } : {})
        const alerts  = extractArray(payload)

        for (const a of alerts) {
          results.push({
            content:    `NinjaOne Alert [${a.severity ?? 'unknown'}]: ${a.message ?? a.description ?? 'No description'} on device ${a.deviceName ?? a.deviceId ?? 'unknown'}`,
            sourceType: 'system' as const,
            sourceRef:  `ninjaone:alert:${a.uid ?? a.id}`,
            occurredAt: new Date(a.createTime ?? a.triggered_at ?? Date.now()),
            metadata:   {
              severity:  a.severity,
              deviceId:  a.deviceId,
              connector: 'ninjaone',
            },
          })
        }
      }

      return results
    },
  }
}
