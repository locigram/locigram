import { QdrantClient } from '@qdrant/js-client-rest'

export interface VectorConfig {
  qdrantUrl:      string
  embeddingUrl:   string
  embeddingModel: string
  embeddingKey?:  string   // optional API key for embedding endpoint
  vectorSize?:    number   // default 768 (nomic-embed-text) or 4096 (Qwen3-Embedding-8B)
}

export function createVectorClient(config: VectorConfig) {
  const client = new QdrantClient({ url: config.qdrantUrl })
  return { client, config }
}

export type VectorClient = ReturnType<typeof createVectorClient>
