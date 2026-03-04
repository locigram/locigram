import * as http from 'http'
import * as https from 'https'
import { config } from './config'

function httpPostJson(url: string, body: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http

    const req = mod.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })

    req.on('error', reject)
    req.setTimeout(20_000, () => { req.destroy(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

export async function pushToLocigram(agentName: string, sessionId: string, transcript: string, occurredAt?: Date): Promise<void> {
  const url = `${config.locigramUrl}/api/sessions/ingest`
  const body = JSON.stringify({
    agentName,
    sessionId,
    transcript,
    occurredAt: (occurredAt ?? new Date()).toISOString(),
  })

  const res = await httpPostJson(url, body, config.apiToken)
  if (res.status >= 200 && res.status < 300) {
    let parsed: any = res.body
    try { parsed = JSON.parse(res.body) } catch { /* keep raw */ }
    console.log(`[session-monitor] locigram push: stored=${parsed?.stored ?? '?'} skipped=${parsed?.skipped ?? '?'}`)
  } else {
    throw new Error(`push failed (${res.status}): ${res.body}`)
  }
}
