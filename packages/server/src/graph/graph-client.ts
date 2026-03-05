import neo4j, { Driver, Session } from 'neo4j-driver'

let _driver: Driver | null = null

export function getGraphDriver(): Driver | null {
  const url = process.env.MEMGRAPH_URL
  if (!url) return null
  if (!_driver) {
    try {
      _driver = neo4j.driver(url, neo4j.auth.none(), {
        connectionTimeout: 5000,
        maxConnectionPoolSize: 10,
      })
    } catch (e) {
      console.warn('[graph] failed to create driver:', e)
      return null
    }
  }
  return _driver
}

export async function runQuery(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const driver = getGraphDriver()
  if (!driver) return
  const session: Session = driver.session()
  try {
    await session.run(cypher, params)
  } catch (e) {
    console.warn('[graph] query error:', e)
  } finally {
    await session.close()
  }
}

export async function runQueryWithResult<T = unknown>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const driver = getGraphDriver()
  if (!driver) return []
  const session: Session = driver.session()
  try {
    const result = await session.run(cypher, params)
    return result.records.map(r => r.toObject() as T)
  } catch (e) {
    console.warn('[graph] query error:', e)
    return []
  } finally {
    await session.close()
  }
}
