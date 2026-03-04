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
    req.write(body)
    req.end()
  })
}

export async function pushToLocigram(agentName: string, sessionId: string, transcript: string): Promise<void> {
  const url = `${config.locigramUrl}/api/sessions/ingest`
  const body = JSON.stringify({
    agentName,
    sessionId,
    transcript,
    occurredAt: new Date().toISOString(),
  })

  try {
    const res = await httpPostJson(url, body, config.apiToken)
    if (res.status >= 200 && res.status < 300) {
      console.log(`[session-monitor] pushed ${agentName}/${sessionId} → ${res.body}`)
    } else {
      console.error(`[session-monitor] push failed (${res.status}): ${res.body}`)
    }
  } catch (err) {
    console.error(`[session-monitor] push error:`, err instanceof Error ? err.message : err)
  }
}
