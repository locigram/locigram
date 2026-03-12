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
    req.setTimeout(120_000, () => { req.destroy(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

// Track sync stats for reporting
let syncStats = { pushed: 0, skipped: 0, errors: 0, lastReportAt: Date.now() }
const REPORT_INTERVAL_MS = 10 * 60_000  // Report every 10 minutes

function useConnectorApi(): boolean {
  return !!(config.connectorToken && config.connectorInstanceId)
}

export async function pushToLocigram(agentName: string, sessionId: string, transcript: string, occurredAt?: Date, locus?: string): Promise<void> {
  if (useConnectorApi()) {
    // New connector framework path
    const url = `${config.locigramUrl}/api/connectors/${config.connectorInstanceId}/ingest`
    const body = JSON.stringify({
      memories: [{
        content: transcript,
        sourceType: 'session-transcript',
        sourceRef: `session:${agentName}/${sessionId}`,
        occurredAt: (occurredAt ?? new Date()).toISOString(),
        locus: locus ?? `agent/${agentName}/session/${sessionId}`,
        importance: 'normal',
        metadata: { agentName, sessionId },
      }],
    })

    const res = await httpPostJson(url, body, config.connectorToken)
    if (res.status >= 200 && res.status < 300) {
      let parsed: any = res.body
      try { parsed = JSON.parse(res.body) } catch { /* keep raw */ }
      console.log(`[session-monitor] connector ingest: ingested=${parsed?.ingested ?? '?'} skipped=${parsed?.skipped ?? '?'}`)
      syncStats.pushed += (parsed?.ingested ?? 1)
      syncStats.skipped += (parsed?.skipped ?? 0)
    } else {
      syncStats.errors++
      throw new Error(`connector ingest failed (${res.status}): ${res.body}`)
    }

    // Periodically report sync stats
    await maybeReportSync()
  } else {
    // Legacy path (palace token, /api/sessions/ingest)
    const url = `${config.locigramUrl}/api/sessions/ingest`
    const body = JSON.stringify({
      agentName,
      sessionId,
      transcript,
      occurredAt: (occurredAt ?? new Date()).toISOString(),
      ...(locus ? { locus } : {}),
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
}

async function maybeReportSync(): Promise<void> {
  if (!useConnectorApi()) return
  if (Date.now() - syncStats.lastReportAt < REPORT_INTERVAL_MS) return
  if (syncStats.pushed === 0 && syncStats.skipped === 0 && syncStats.errors === 0) return

  const url = `${config.locigramUrl}/api/connectors/${config.connectorInstanceId}/report`
  const body = JSON.stringify({
    itemsPulled: syncStats.pushed + syncStats.skipped + syncStats.errors,
    itemsPushed: syncStats.pushed,
    itemsSkipped: syncStats.skipped,
    ...(syncStats.errors > 0 ? { error: `${syncStats.errors} ingest errors` } : {}),
  })

  try {
    await httpPostJson(url, body, config.connectorToken)
    console.log(`[session-monitor] sync report sent: pushed=${syncStats.pushed} skipped=${syncStats.skipped} errors=${syncStats.errors}`)
  } catch (e) {
    console.warn(`[session-monitor] sync report failed: ${e}`)
  }

  syncStats = { pushed: 0, skipped: 0, errors: 0, lastReportAt: Date.now() }
}

export async function pushCheckpoint(agentName: string, sessionId: string, summary: string, occurredAt?: Date, locus?: string): Promise<void> {
  const resolvedLocus = locus ?? `agent/${agentName}/context`
  // Extract a meaningful object_val — first sentence or first 200 chars
  const firstSentence = summary.match(/^[^.!?\n]+[.!?]?/)?.[0]?.trim()
  const objectVal = firstSentence && firstSentence.length > 20 ? firstSentence.slice(0, 200) : summary.slice(0, 200)

  if (useConnectorApi()) {
    const url = `${config.locigramUrl}/api/connectors/${config.connectorInstanceId}/ingest`
    const body = JSON.stringify({
      memories: [{
        content: summary,
        sourceType: 'system',
        sourceRef: `session:${agentName}/${sessionId}/checkpoint`,
        occurredAt: (occurredAt ?? new Date()).toISOString(),
        locus: resolvedLocus,
        metadata: { agentName, sessionId, type: 'checkpoint' },
        category: 'checkpoint',
        durability_class: 'checkpoint',
        importance: 'high',
        subject: agentName,
        predicate: 'compaction_state',
        object_val: objectVal,
      }],
    })

    const res = await httpPostJson(url, body, config.connectorToken)
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`checkpoint ingest failed (${res.status}): ${res.body}`)
    }
  } else {
    // Legacy path — POST to remember endpoint with structured fields
    const url = `${config.locigramUrl}/api/remember`
    const body = JSON.stringify({
      content: summary,
      locus: resolvedLocus,
      sourceType: 'system',
      source_ref: `session:${agentName}/${sessionId}/checkpoint`,
      category: 'checkpoint',
      durability_class: 'checkpoint',
      importance: 'high',
      subject: agentName,
      predicate: 'compaction_state',
      object_val: objectVal,
    })

    const res = await httpPostJson(url, body, config.apiToken)
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`checkpoint push failed (${res.status}): ${res.body}`)
    }
  }
}

// Export for shutdown hook
export async function flushSyncReport(): Promise<void> {
  if (!useConnectorApi()) return
  syncStats.lastReportAt = 0  // Force report
  await maybeReportSync()
}
