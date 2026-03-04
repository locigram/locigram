/**
 * One-shot completion subcommand for ephemeral agents.
 *
 * Finds the most recent session JSONL, generates a summary via the Locigram
 * server's /api/internal/summarize endpoint, pushes the result to Locigram
 * under locus agent/{agentName}/session/{sessionId}, and optionally writes
 * a completion-report.md to LOCIGRAM_HANDOFF_PATH.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { config } from './config'
import { pushToLocigram } from './ingest'

const LOG_PREFIX = '[complete]'

function log(msg: string): void {
  console.log(`${LOG_PREFIX}[${config.agentName}] ${msg}`)
}

function warn(msg: string): void {
  console.warn(`${LOG_PREFIX}[${config.agentName}] ${msg}`)
}

// ── Find newest session JSONL ───────────────────────────────────────────────

async function findNewestSessionFile(): Promise<string | null> {
  const sessionsDir = path.join(config.agentsDir, config.agentName, 'sessions')
  let files: string[] = []
  try {
    files = await fsp.readdir(sessionsDir)
  } catch {
    warn(`unable to read sessions dir: ${sessionsDir}`)
    return null
  }

  let newestPath: string | null = null
  let newestMtime = -1

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const full = path.join(sessionsDir, file)
    try {
      const st = await fsp.stat(full)
      if (st.mtimeMs > newestMtime) {
        newestMtime = st.mtimeMs
        newestPath = full
      }
    } catch { /* skip */ }
  }

  return newestPath
}

// ── Read JSONL messages ─────────────────────────────────────────────────────

async function readJsonlMessages(jsonlPath: string, maxMessages = 150): Promise<string> {
  const content = await fsp.readFile(jsonlPath, 'utf8')
  const lines = content.split('\n').filter((l: string) => l.trim())
  const messages: Array<{ role: string; text: string }> = []

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type !== 'message') continue
      const msg = obj.message
      if (!msg || !['user', 'assistant'].includes(msg.role)) continue
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
        : String(msg.content ?? '')
      const cleaned = text.replace(/Conversation info \(untrusted metadata\)[\s\S]*?\n\n/g, '').trim()
      if (!cleaned) continue
      const truncated = cleaned.length > 600 ? cleaned.slice(0, 600) + '\u2026' : cleaned
      messages.push({ role: msg.role, text: truncated })
    } catch { /* skip bad lines */ }
  }

  if (messages.length === 0) return ''

  const first = messages.slice(0, 10)
  const last = messages.slice(-Math.min(maxMessages - 10, messages.length))
  const combined = messages.length > maxMessages
    ? [...first, { role: 'system', text: `[... ${messages.length - first.length - last.length} messages omitted ...]` }, ...last]
    : messages

  return combined.map(m => `[${m.role}]: ${m.text}`).join('\n\n')
}

// ── Call LLM via Locigram server ────────────────────────────────────────────

function httpPostJson(urlString: string, body: object, headers: Record<string, string>, timeoutMs = 30_000): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const data = JSON.stringify(body)
    const isHttps = url.protocol === 'https:'
    const client = isHttps ? https : http
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
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
    req.write(data)
    req.end()
  })
}

// ── Main completion flow ────────────────────────────────────────────────────

export async function runComplete(): Promise<void> {
  log('starting one-shot completion summary')

  // 1. Find newest session JSONL
  const sessionPath = await findNewestSessionFile()
  if (!sessionPath) {
    warn('no session JSONL files found — nothing to summarize')
    process.exit(0)
  }

  const sessionId = path.basename(sessionPath, '.jsonl')
  log(`session: ${sessionId}`)
  log(`file: ${sessionPath}`)

  // 2. Read transcript
  const transcript = await readJsonlMessages(sessionPath, 150)
  if (!transcript) {
    warn('session file is empty or contains no messages — nothing to summarize')
    process.exit(0)
  }

  log(`transcript: ${transcript.length} chars`)

  // 3. Call /api/internal/summarize
  const prompt = [
    `You are summarizing a completed AI assistant session for agent "${config.agentName}".`,
    'This is a COMPLETION SUMMARY — the task is done. Extract:',
    '1. What was the task/project (1 sentence)',
    '2. Key decisions made (bullet list, most important first)',
    '3. Files/code changed (bullet list)',
    '4. Final outcome / deliverable',
    '5. Any loose ends or follow-up items',
    '',
    'Keep it under 500 words. Be specific and focused on outcomes.',
    '',
    'TRANSCRIPT:',
    transcript,
  ].join('\n')

  let summary: string
  let structured: Record<string, unknown> | null = null

  try {
    const res = await httpPostJson(
      `${config.locigramUrl}/api/internal/summarize`,
      { prompt, maxTokens: 1200 },
      { 'Authorization': `Bearer ${config.apiToken}` },
      150_000,
    )
    if (res.status >= 200 && res.status < 300 && res.data?.narrative) {
      summary = res.data.narrative
      structured = res.data.structured ?? null
      log('LLM summary received')
    } else {
      warn(`summarize returned ${res.status}; using raw transcript tail`)
      summary = `## Completion Summary (LLM unavailable)\n\n${transcript.split('\n').slice(-100).join('\n')}`
    }
  } catch (e: any) {
    warn(`summarize call failed: ${e.message}; using raw transcript tail`)
    summary = `## Completion Summary (LLM unavailable)\n\n${transcript.split('\n').slice(-100).join('\n')}`
  }

  // 4. Push to Locigram under locus agent/{agentName}/session/{sessionId}
  const sessionLocus = `agent/${config.agentName}/session/${sessionId}`
  try {
    await pushToLocigram(config.agentName, sessionId, summary, new Date(), sessionLocus)
    log(`pushed to Locigram: locus=${sessionLocus}`)
  } catch (e: any) {
    warn(`Locigram push failed: ${e.message}`)
  }

  // 5. Write completion-report.md to LOCIGRAM_HANDOFF_PATH if set
  if (config.handoffPath) {
    const reportPath = config.handoffPath.endsWith('.md')
      ? config.handoffPath.replace(/\.md$/, '-completion-report.md')
      : config.handoffPath + '/completion-report.md'
    const now = new Date()
    const report = [
      `# Completion Report — ${config.agentName}`,
      `_Completed: ${now.toISOString()}_`,
      `_Session: ${sessionId}_`,
      '',
      summary,
      '',
    ].join('\n')

    await fsp.mkdir(path.dirname(reportPath), { recursive: true })
    await fsp.writeFile(reportPath, report, 'utf8')
    log(`completion report written: ${reportPath}`)
  }

  log('done')
  process.exit(0)
}
