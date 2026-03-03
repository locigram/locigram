export interface M365AuthConfig {
  tenantId:     string
  clientId:     string
  clientSecret: string
}

const TOKEN_CACHE = new Map<string, { token: string; expiresAt: number }>()

export async function getGraphToken(config: M365AuthConfig): Promise<string> {
  const cacheKey = `${config.tenantId}:${config.clientId}`
  const cached   = TOKEN_CACHE.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const url = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     config.clientId,
      client_secret: config.clientSecret,
      scope:         'https://graph.microsoft.com/.default',
    }),
  })

  if (!res.ok) throw new Error(`M365 auth failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { access_token: string; expires_in: number }
  TOKEN_CACHE.set(cacheKey, {
    token:     data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  })

  return data.access_token
}

export async function graphGet(token: string, url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5')
    await new Promise(r => setTimeout(r, retryAfter * 1000))
    return graphGet(token, url)
  }
  if (!res.ok) throw new Error(`Graph API error: ${res.status} ${url}`)
  return res.json()
}
