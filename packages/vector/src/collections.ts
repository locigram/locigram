import type { QdrantClient } from '@qdrant/js-client-rest'

export async function ensureCollection(
  client: QdrantClient,
  collectionName: string,
  vectorSize = 4096,
): Promise<void> {
  try {
    await client.getCollection(collectionName)
    // already exists
  } catch {
    await client.createCollection(collectionName, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    })
    console.log(`[vector] created collection: ${collectionName}`)
  }
}
