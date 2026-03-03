import type { VectorConfig } from './client'

export async function embed(text: string, config: Pick<VectorConfig, 'embeddingUrl' | 'embeddingModel'>): Promise<number[]> {
  const res = await fetch(`${config.embeddingUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
