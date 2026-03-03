import type { QdrantClient } from '@qdrant/js-client-rest'

export interface SearchOptions {
  palaceId: string
  locus?: string       // filter by locus prefix
  limit?: number
  minScore?: number
}

export interface SearchResult {
  id: string
  score: number
  payload: Record<string, unknown>
}

export async function searchSimilar(
  client: QdrantClient,
  collectionName: string,
  queryVector: number[],
  opts: SearchOptions,
): Promise<SearchResult[]> {
  const must: object[] = [
    { key: 'palace_id', match: { value: opts.palaceId } },
  ]

  if (opts.locus) {
    must.push({ key: 'locus', match: { text: opts.locus } })
  }

  const results = await client.search(collectionName, {
    vector: queryVector,
    limit: opts.limit ?? 10,
    score_threshold: opts.minScore ?? 0.0,
    filter: { must },
    with_payload: true,
  })

  return results.map(r => ({
    id: String(r.id),
    score: r.score,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }))
}
