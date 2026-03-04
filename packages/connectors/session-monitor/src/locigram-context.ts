/**
 * Locigram as query layer.
 *
 * Fetches active context, fleet status, and per-agent context from the
 * Locigram server via REST API. Falls back to reading active-context.json
 * from disk if the server is unavailable.
 */

import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import type { config as Config } from './config'

type AppConfig = typeof Config

export interface ActiveContext {
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

export interface AgentState {
  agentName: string
  currentTask: string | null
  currentProject: string | null
  blockers: string[]
  domain: string | null
  lastSeen: string
  agentType: string
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
 * Uses hierarchical locus: agent/{agentName}/context
 * Legacy flat loci (agent/{agentName}) are mapped server-side.
 */
export async function fetchActiveContextFromLocigram(config: AppConfig): Promise<ActiveContext | null> {
  const { locigramUrl, apiToken, agentName } = config

  // Try server first — use hierarchical locus
  if (locigramUrl && apiToken) {
    try {
      const url = `${locigramUrl}/api/context/active?locus=agent/${encodeURIComponent(agentName)}/context`
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

/**
 * Fetch fleet status — all agents that have pushed context to Locigram.
 * Calls GET /api/context/fleet.
 * Returns an array of agent states.
 */
export async function fetchFleetStatus(config: AppConfig): Promise<AgentState[]> {
  const { locigramUrl, apiToken } = config

  if (!locigramUrl || !apiToken) {
    return []
  }

  try {
    const url = `${locigramUrl}/api/context/fleet`
    const res = await httpGet(url, apiToken)
    if (res.status >= 200 && res.status < 300 && Array.isArray(res.data)) {
      return res.data as AgentState[]
    }
  } catch {
    // Server unavailable
  }

  return []
}

/**
 * Fetch a specific agent's active context from Locigram.
 * Calls GET /api/context/active?locus=agent/{agentName}/context.
 */
export async function fetchAgentContext(config: AppConfig, agentName: string): Promise<ActiveContext | null> {
  const { locigramUrl, apiToken } = config

  if (!locigramUrl || !apiToken) {
    return null
  }

  try {
    const url = `${locigramUrl}/api/context/active?locus=agent/${encodeURIComponent(agentName)}/context`
    const res = await httpGet(url, apiToken)
    if (res.status >= 200 && res.status < 300 && res.data) {
      return res.data as ActiveContext
    }
  } catch {
    // Server unavailable
  }

  return null
}
