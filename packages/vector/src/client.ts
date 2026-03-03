import { QdrantClient } from '@qdrant/js-client-rest'

export interface VectorConfig {
  qdrantUrl: string
  embeddingUrl: string
  embeddingModel: string
  vectorSize?: number  // default 4096 (Qwen3-Embedding-8B)
}

export function createVectorClient(config: VectorConfig) {
  const client = new QdrantClient({ url: config.qdrantUrl })
  return { client, config }
}

export type VectorClient = ReturnType<typeof createVectorClient>
