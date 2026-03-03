import type { QdrantClient } from '@qdrant/js-client-rest'

export interface EmbeddingPayload {
  palace_id: string
  locus: string
  source_type: string
  entities: string[]
  confidence: number
  created_at: string  // ISO string
}

export async function upsertEmbedding(
  client: QdrantClient,
  collectionName: string,
  locigramId: string,
  vector: number[],
  payload: EmbeddingPayload,
): Promise<void> {
  await client.upsert(collectionName, {
    wait: true,
    points: [{ id: locigramId, vector, payload }],
  })
}
