/**
 * Strava OAuth2 token management.
 * Tokens expire every 6 hours — auto-refreshes transparently.
 */

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_at: number  // unix timestamp
  token_type: string
}

let cachedToken: { accessToken: string; expiresAt: number; refreshToken: string } | null = null

function getEnv() {
  return {
    clientId: process.env.STRAVA_CLIENT_ID ?? '',
    clientSecret: process.env.STRAVA_CLIENT_SECRET ?? '',
    refreshToken: process.env.STRAVA_REFRESH_TOKEN ?? '',
    accessToken: process.env.STRAVA_ACCESS_TOKEN ?? '',
  }
}

/**
 * Exchange an authorization code for tokens (one-time setup).
 */
export async function exchangeCode(code: string): Promise<TokenResponse> {
  const env = getEnv()
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`Strava auth failed: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * Refresh an expired access token.
 */
async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const env = getEnv()
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * Get a valid access token, refreshing if expired.
 */
export async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  // Use cached token if still valid (with 5-min buffer)
  if (cachedToken && cachedToken.expiresAt > now + 300) {
    return cachedToken.accessToken
  }

  const env = getEnv()
  const refreshToken = cachedToken?.refreshToken ?? env.refreshToken

  if (!refreshToken && env.accessToken) {
    // Use the static access token (may be expired)
    cachedToken = { accessToken: env.accessToken, expiresAt: now + 3600, refreshToken: '' }
    return env.accessToken
  }

  if (!refreshToken) {
    throw new Error('No STRAVA_REFRESH_TOKEN or STRAVA_ACCESS_TOKEN configured')
  }

  console.log('[strava] Refreshing access token...')
  const tokens = await refreshAccessToken(refreshToken)
  cachedToken = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
  }

  return tokens.access_token
}

/**
 * Generate the OAuth authorization URL for initial setup.
 */
export function getAuthUrl(redirectUri: string): string {
  const env = getEnv()
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
  })
  return `https://www.strava.com/oauth/authorize?${params}`
}
