import type { QdrantClient } from '@qdrant/js-client-rest'

export async function deleteEmbedding(
  client: QdrantClient,
  collectionName: string,
  locigramId: string,
): Promise<void> {
  await client.delete(collectionName, {
    wait: true,
    points: [locigramId],
  })
}
