import { Hono } from 'hono'

const baseUrl = () => process.env.LOCIGRAM_PUBLIC_URL || 'http://localhost:3000'

export const metadataRoute = new Hono()

// RFC 8414 — Authorization Server Metadata
metadataRoute.get('/', (c) => {
  const issuer = baseUrl()
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  })
})

// RFC 9728 — Protected Resource Metadata (required by Claude.ai MCP)
export const protectedResourceRoute = new Hono()

protectedResourceRoute.get('/', (c) => {
  const issuer = baseUrl()
  return c.json({
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  })
})
