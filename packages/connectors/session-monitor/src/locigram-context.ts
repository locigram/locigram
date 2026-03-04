/**
 * Locigram as query layer — future direction.
 *
 * Fetches active context from the Locigram server via REST API.
 * Falls back to reading active-context.json from disk if the server is unavailable.
 *
 * This enables agents to query Locigram directly for their current context
 * instead of relying solely on the local active-context.json file.
 */

import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import type { config as Config } from './config'

type AppConfig = typeof Config

interface ActiveContext {
  currentTask: string
  currentProject: string
  pendingActions: string[]
  recentDecisions: string[]
  blockers: string[]
  activeAgents: string[]
  domain: string
  _autoUpdated: string
  _sessionId: string
  _finalSnapshot?: boolean
}

function httpGet(urlString: string, token: string, timeoutMs = 10_000): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const isHttps = url.protocol === 'https:'
    const client = isHttps ? https : http
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          let parsed: any = raw
          try { parsed = JSON.parse(raw) } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, data: parsed })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    req.end()
  })
}

/**
 * Fetch active context from Locigram server.
 * Falls back to disk read of active-context.json if server is unavailable.
 *
 * Future endpoint: GET {locigramUrl}/api/context/active?locus=agent/{agentName}
 */
export async function fetchActiveContextFromLocigram(config: AppConfig): Promise<ActiveContext | null> {
  const { locigramUrl, apiToken, agentName } = config

  // Try server first
  if (locigramUrl && apiToken) {
    try {
      const url = `${locigramUrl}/api/context/active?locus=agent/${encodeURIComponent(agentName)}`
      const res = await httpGet(url, apiToken)
      if (res.status >= 200 && res.status < 300 && res.data) {
        return res.data as ActiveContext
      }
    } catch {
      // Server unavailable — fall through to disk
    }
  }

  // Fallback: read from disk
  const diskPath = config.activeContextPath
  if (!diskPath) return null

  try {
    const raw = await fsp.readFile(diskPath, 'utf8')
    return JSON.parse(raw) as ActiveContext
  } catch {
    return null
  }
}
