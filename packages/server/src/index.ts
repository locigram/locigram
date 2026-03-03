import { createApp } from './app'

const config = {
  databaseUrl: process.env.DATABASE_URL!,
  palaceId:    process.env.PALACE_ID!,
  apiToken:    process.env.API_TOKEN,
}

if (!config.databaseUrl) throw new Error('DATABASE_URL is required')
if (!config.palaceId)    throw new Error('PALACE_ID is required')

const app = createApp(config)
const port = parseInt(process.env.PORT ?? '3000')

console.log(`[locigram] palace=${config.palaceId} port=${port}`)

export default {
  port,
  fetch: app.fetch,
}
