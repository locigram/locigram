import { createApp } from './app'

const config = {
  databaseUrl:    process.env.DATABASE_URL!,
  palaceId:       process.env.PALACE_ID!,
  apiToken:       process.env.API_TOKEN,
  qdrantUrl:      process.env.QDRANT_URL      ?? 'http://localhost:6333',
  embeddingUrl:   process.env.EMBEDDING_URL   ?? 'http://YOUR_K8S_NODE_IP:30888/v1',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'mlx-community/Qwen3-Embedding-8B-mxfp8',
  llmUrl:         process.env.MIDRANGE_LB_URL ?? 'http://YOUR_K8S_NODE_IP:30891/v1',
  llmModel:       process.env.EXTRACTION_MODEL,
}

if (!config.databaseUrl) throw new Error('DATABASE_URL is required')
if (!config.palaceId)    throw new Error('PALACE_ID is required')

const app  = createApp(config)
const port = parseInt(process.env.PORT ?? '3000')

console.log(`[locigram] palace=${config.palaceId} listening on :${port}`)

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[locigram] SIGTERM received — shutting down')
  app.stop()
  process.exit(0)
})

export default {
  port,
  fetch: app.fetch,
}
