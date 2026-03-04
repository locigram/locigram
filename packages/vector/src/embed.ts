import type { VectorConfig } from './client'

export async function embed(
  text: string,
  config: Pick<VectorConfig, 'embeddingUrl' | 'embeddingModel' | 'embeddingKey'>,
): Promise<number[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.embeddingKey) headers['Authorization'] = `Bearer ${config.embeddingKey}`

  const res = await fetch(`${config.embeddingUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.embeddingModel, input: text }),
  })

  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json() as { data: Array<{ embedding: number[] }> }
  const vector = data?.data?.[0]?.embedding
  if (!vector || !Array.isArray(vector)) {
    throw new Error('Invalid embedding response — no vector returned')
  }

  return vector
}
