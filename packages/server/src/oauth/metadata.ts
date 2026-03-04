import { Hono } from 'hono'

const baseUrl = () => process.env.LOCIGRAM_PUBLIC_URL || 'http://localhost:3000'

export const metadataRoute = new Hono()

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
