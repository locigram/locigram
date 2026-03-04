import { createApp } from './app'
import { defaultLLMConfig } from '@locigram/pipeline'

const config = {
  databaseUrl: process.env.DATABASE_URL!,
  palaceId:    process.env.PALACE_ID!,
  apiToken:    process.env.API_TOKEN,
  qdrantUrl:   process.env.QDRANT_URL ?? 'http://localhost:6333',
  llm:         defaultLLMConfig(),
}

const port = parseInt(process.env.PORT ?? '3000')
const app  = createApp(config)

console.log(`[locigram] palace=${config.palaceId} port=${port}`)
console.log(`[locigram] embed=${config.llm.embed.url} model=${config.llm.embed.model}`)
console.log(`[locigram] extract=${config.llm.extract.url} model=${config.llm.extract.model}`)
console.log(`[locigram] summary=${config.llm.summary.url} model=${config.llm.summary.model}`)

export default {
  port,
  fetch: app.fetch,
}

process.on('SIGTERM', () => {
  console.log('[locigram] SIGTERM — shutting down')
  app.stop()
  process.exit(0)
})
