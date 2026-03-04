import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { config } from './config'
import { pushToLocigram } from './ingest'

const LOG_PREFIX = '[session-monitor]'
const SECTION_BREAK_EVERY_N = 15

// ── State ────────────────────────────────────────────────────────────────────

let currentSessionPath: string | null = null
let currentSessionId = 'unknown'
let lastReadPosition = 0
let pendingLineBuffer = ''
let parsedMessageCount = 0
let sectionNumber = 1
let lastHandoffAt = 0
let lastSummaryMessageCount = 0
let shuttingDown = false

// ── Logging ──────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.log(`${LOG_PREFIX}[${config.agentName}] ${message}`)
}

function warn(message: string): void {
  console.warn(`${LOG_PREFIX}[${config.agentName}] ${message}`)
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatTimestamp(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)}`
}

// ── Session file discovery ───────────────────────────────────────────────────

async function findNewestSessionFile(): Promise<string | null> {
  const sessionsDir = path.join(config.agentsDir, config.agentName, 'sessions')
  let files: string[] = []
  try {
    files = await fsp.readdir(sessionsDir)
  } catch (error) {
    warn(`unable to read sessions dir ${sessionsDir}: ${String(error)}`)
    return null
  }

  let newestPath: string | null = null
  let newestMtime = -1
  let newestSize = -1

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const full = path.join(sessionsDir, file)
    try {
      const st = await fsp.stat(full)
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
      const recentlyActive = st.mtimeMs > twoHoursAgo
      const score = recentlyActive ? st.size : 0
      if (score > newestSize || (score === newestSize && st.mtimeMs > newestMtime)) {
        newestSize = score
        newestMtime = st.mtimeMs
        newestPath = full
      }
    } catch { /* skip */ }
  }

  return newestPath
}

function deriveSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl')
}

// ── JSONL parsing (exact port from monitor.ts) ───────────────────────────────

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const chunks: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const typedPart = part as { type?: string; text?: unknown }
    if (typedPart.type === 'text' && typeof typedPart.text === 'string') chunks.push(typedPart.text)
  }
  return chunks.join('\n').trim()
}

function parseTimestamp(raw: unknown): Date {
  if (typeof raw === 'string' || typeof raw === 'number') {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

function parseTranscriptLine(rawLine: string): string | null {
  if (!rawLine.trim()) return null
  let row: any
  try { row = JSON.parse(rawLine) } catch { return null }
  if (row?.type !== 'message') return null
  const role = row?.message?.role
  if (role !== 'user' && role !== 'assistant') return null
  const text = extractMessageText(row?.message?.content)
  if (!text) return null
  if (text.length > 200 && (text.includes('tool_call') || text.includes('toolResult') || text.includes('function_call'))) return null
  const ts = parseTimestamp(row?.timestamp ?? row?.message?.created_at)
  return `[${formatTime(ts)}] [${role}]: ${text}\n`
}

// ── Incremental file reading ─────────────────────────────────────────────────

async function readIncrementalChunk(filePath: string, from: number, to: number): Promise<string> {
  if (to <= from) return ''
  const fh = await fsp.open(filePath, 'r')
  try {
    const length = to - from
    const buffer = Buffer.alloc(length)
    await fh.read(buffer, 0, length, from)
    return buffer.toString('utf8')
  } finally {
    await fh.close()
  }
}

// ── Transcript writing ───────────────────────────────────────────────────────

async function ensureTranscriptDir(): Promise<void> {
  if (!config.handoffPath) return
  await fsp.mkdir(path.dirname(config.handoffPath), { recursive: true })
}

async function appendTranscript(entries: string[]): Promise<void> {
  if (entries.length === 0) return
  for (const _entry of entries) {
    parsedMessageCount += 1
    if (parsedMessageCount > 1 && (parsedMessageCount - lastSummaryMessageCount) >= config.summaryEveryN) {
      lastSummaryMessageCount = parsedMessageCount
      setImmediate(() => triggerHandoffDump(0, 'message-count').catch(() => {}))
    }
  }
  log(`new messages parsed: ${entries.length}`)
}

async function processSessionGrowth(filePath: string, size: number): Promise<void> {
  if (size < lastReadPosition) { lastReadPosition = 0; pendingLineBuffer = '' }
  const chunk = await readIncrementalChunk(filePath, lastReadPosition, size)
  lastReadPosition = size
  if (!chunk) return
  const combined = pendingLineBuffer + chunk
  const lines = combined.split(/\r?\n/)
  pendingLineBuffer = lines.pop() ?? ''
  const parsed: string[] = []
  for (const line of lines) {
    const formatted = parseTranscriptLine(line)
    if (formatted) parsed.push(formatted)
  }
  await appendTranscript(parsed)
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpPostJson(urlString: string, body: object, headers?: Record<string, string>, timeoutMs = 30_000): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const data = JSON.stringify(body)
    const isHttps = url.protocol === 'https:'
    const client = isHttps ? https : http
    const reqHeaders: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      ...headers,
    }
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: reqHeaders,
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

// ── LLM summarization via Locigram server ────────────────────────────────────

async function callLlm(prompt: string): Promise<string | null> {
  try {
    const res = await httpPostJson(
      `${config.locigramUrl}/api/internal/summarize`,
      { prompt, maxTokens: 800 },
      { 'Authorization': `Bearer ${config.apiToken}` },
      150_000,
    )
    if (res.status >= 200 && res.status < 300 && res.data?.summary) {
      return res.data.summary
    }
    warn(`/api/internal/summarize returned ${res.status}`)
    return null
  } catch (error) {
    warn(`callLlm failed: ${String(error)}`)
    return null
  }
}

// ── Read raw JSONL messages for handoff prompt ───────────────────────────────

async function readLastJsonlMessages(jsonlPath: string, maxMessages = 150): Promise<string> {
  try {
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
  } catch { return '' }
}

// ── Handoff dump ─────────────────────────────────────────────────────────────

async function triggerHandoffDump(triggerSizeMb: number, triggerReason = 'file-size'): Promise<void> {
  let condensedTranscript = ''
  if (currentSessionPath) {
    condensedTranscript = await readLastJsonlMessages(currentSessionPath, 150)
    if (condensedTranscript) log('handoff: using jsonl as source (' + condensedTranscript.length + ' chars)')
  }
  if (!condensedTranscript) {
    warn('handoff trigger skipped: no transcript available')
    return
  }

  const prompt = [
    `You are summarizing an ongoing AI assistant session for agent "${config.agentName}" for context handoff.`,
    'Read the transcript below and extract:',
    '1. Current task/project (1 sentence \u2014 what is being worked on RIGHT NOW)',
    '2. Key decisions made this session (bullet list, max 15, most recent first)',
    '3. Files/code changed (bullet list with what changed)',
    '4. What was being worked on in the most recent messages',
    '5. Immediate next steps (ordered list)',
    '',
    'Keep it under 600 words. Be specific. Focus on recent activity but capture the full arc.',
    '',
    'TRANSCRIPT (beginning + recent):',
    condensedTranscript,
  ].join('\n')

  let summary = await callLlm(prompt)
  if (!summary) {
    warn('handoff summary unavailable; writing raw transcript tail as fallback')
    const tail = condensedTranscript.split('\n').slice(-150).join('\n')
    summary = `## Raw Transcript Tail (last 150 lines \u2014 LLM unavailable)\n\n${tail}`
  }

  const now = new Date()

  // Write handoff file if configured
  if (config.handoffPath) {
    const out = [
      `# Live Session Handoff \u2014 ${config.agentName}`,
      `_Updated: ${formatTimestamp(now)}_`,
      `_Trigger: ${triggerReason === 'file-size' ? `file size ${triggerSizeMb.toFixed(2)}mb` : `every ${config.summaryEveryN} messages (msg #${parsedMessageCount})`}_`,
      '',
      summary, '',
    ].join('\n')
    await fsp.writeFile(config.handoffPath, out, 'utf8')
    log(`handoff dump written (${triggerReason}): ${config.handoffPath}`)
  }

  lastHandoffAt = Date.now()

  // Post summary to Discord webhook if configured
  if (config.discordWebhookUrl) {
    try {
      const truncated = summary.length > 1800 ? summary.slice(0, 1800) + '\n\u2026*(truncated)*' : summary
      const msg = `**Session Handoff \u2014 ${config.agentName}**\n_${formatTimestamp(now)} \u00b7 ${triggerReason}_\n\n${truncated}`
      await httpPostJson(config.discordWebhookUrl, { content: msg }, {})
      log('handoff posted to Discord')
    } catch (e: any) {
      warn(`Discord post failed: ${e.message}`)
    }
  }

  // Always push summary to Locigram
  try {
    await pushToLocigram(config.agentName, currentSessionId, summary, now)
    log('handoff pushed to Locigram')
  } catch (e: any) {
    warn(`Locigram push error: ${e.message}`)
  }
}

// ── Size-based handoff trigger ───────────────────────────────────────────────

async function maybeTriggerHandoff(sessionSizeBytes: number): Promise<void> {
  const thresholdBytes = config.compactionMb * 1024 * 1024
  if (sessionSizeBytes < thresholdBytes) return
  const elapsed = Date.now() - lastHandoffAt
  if (elapsed < config.dumpCooldownMs) return
  const sizeMb = sessionSizeBytes / (1024 * 1024)
  log(`handoff trigger: file size ${sizeMb.toFixed(2)}mb`)
  await triggerHandoffDump(sizeMb)
}

// ── Handoff archival on session switch ────────────────────────────────────────

async function archiveHandoffOnSessionSwitch(): Promise<void> {
  if (!config.handoffPath) return
  try {
    const existing = await fsp.readFile(config.handoffPath, 'utf8')
    if (!existing.trim()) return
    const now = new Date()
    const ts = formatTimestamp(now).replace(/[/:]/g, '-').replace(/\s/g, '_')
    const archivePath = config.handoffPath.replace('.md', `-archived-${ts}.md`)
    await fsp.writeFile(archivePath, existing, 'utf8')
    log(`archived pre-compaction handoff to ${archivePath}`)
    // Also append to today's memory flush file if workspace configured
    if (config.workspaceRoot) {
      const memoryDir = path.join(config.workspaceRoot, 'memory')
      await fsp.mkdir(memoryDir, { recursive: true })
      const dateStamp = formatDate(now)
      const memoryPath = path.join(memoryDir, `${dateStamp}.md`)
      const separator = `\n\n---\n\n# Session Monitor Handoff Archive \u2014 ${formatTimestamp(now)}\n\n`
      await fsp.appendFile(memoryPath, separator + existing, 'utf8')
      log(`appended handoff to memory flush file ${memoryPath}`)
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') warn(`failed to archive handoff: ${e.message}`)
  }
}

// ── Project detection (optional, requires workspaceRoot) ─────────────────────

function sanitizeProjectName(raw: string): string {
  const firstToken = raw.split(/[\r\n]/)[0] ?? ''
  const cleaned = firstToken.replace(/[^A-Za-z0-9-]/g, '').replace(/^-+/, '').replace(/-+$/, '')
  return cleaned || 'Unknown-Project'
}

async function detectProject(): Promise<void> {
  if (!config.workspaceRoot || !config.obsidianVault) return
  if (!currentSessionPath) return
  // Read recent transcript for project detection
  const content = await readLastJsonlMessages(currentSessionPath, 30)
  if (!content) { warn('project detection: transcript empty, skipping'); return }
  const prompt = [
    'Based on this conversation snippet, what project/feature is being worked on?',
    'Reply with just a short project name (2-4 words, no spaces, use hyphens).',
    `CONVERSATION: ${content}`,
  ].join('\n')
  const llmResult = await callLlm(prompt)
  if (!llmResult) { warn('project detection: LLM unavailable'); return }
  const projectName = sanitizeProjectName(llmResult)
  if (!projectName) return
  // Create project stub if Obsidian vault configured
  const projectsDir = path.join(config.obsidianVault, 'Projects')
  const targetPath = path.join(projectsDir, `${projectName}.md`)
  try { await fsp.access(targetPath, fs.constants.F_OK); return } catch { /* create */ }
  await fsp.mkdir(projectsDir, { recursive: true })
  const body = `# ${projectName}\n\n## Current State\n- Newly detected by session-monitor\n`
  await fsp.writeFile(targetPath, body, 'utf8')
  log(`project detection: created stub ${targetPath}`)
}

// ── Session attachment ───────────────────────────────────────────────────────

async function attachSessionFile(sessionPath: string): Promise<void> {
  // Archive handoff before switching sessions
  if (currentSessionPath && currentSessionPath !== sessionPath) {
    await archiveHandoffOnSessionSwitch()
  }
  if (currentSessionPath) fs.unwatchFile(currentSessionPath)
  currentSessionPath = sessionPath
  currentSessionId = deriveSessionId(sessionPath)
  lastReadPosition = 0
  pendingLineBuffer = ''
  log(`session file found: ${sessionPath}`)
  await ensureTranscriptDir()
  const initialStat = await fsp.stat(sessionPath)
  lastReadPosition = initialStat.size
  lastSummaryMessageCount = 0
  parsedMessageCount = 0
  sectionNumber = 1
  log(`watching session; skipping ${(initialStat.size / 1024 / 1024).toFixed(1)}mb of existing history`)
  fs.watchFile(sessionPath, { interval: config.watchIntervalMs }, async (curr) => {
    if (shuttingDown) return
    try {
      await processSessionGrowth(sessionPath, curr.size)
      await maybeTriggerHandoff(curr.size)
    } catch (error) { warn(`watch error: ${String(error)}`) }
  })
}

// ── Session scanning ─────────────────────────────────────────────────────────

async function scanAndMaybeSwitchSession(): Promise<void> {
  const newest = await findNewestSessionFile()
  if (!newest || newest === currentSessionPath) return
  try { await attachSessionFile(newest) }
  catch (error) { warn(`failed to attach session file ${newest}: ${String(error)}`) }
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

function setupShutdownHandlers(sessionTimer: NodeJS.Timeout, projectTimer: NodeJS.Timeout | null): void {
  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log(`received ${signal}; final handoff dump...`)
    clearInterval(sessionTimer)
    if (projectTimer) clearInterval(projectTimer)
    if (currentSessionPath) fs.unwatchFile(currentSessionPath)
    try {
      const sizeMb = currentSessionPath ? (await fsp.stat(currentSessionPath)).size / (1024 * 1024) : 0
      await triggerHandoffDump(sizeMb, 'shutdown')
    } catch (error) { warn(`shutdown handoff failed: ${String(error)}`) }
    process.exit(0)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function startDaemon(): void {
  const sessionsDir = path.join(config.agentsDir, config.agentName, 'sessions')
  log('daemon started')
  log(`agent: ${config.agentName}`)
  log(`sessions dir: ${sessionsDir}`)
  log(`summary every ${config.summaryEveryN} messages`)
  log(`compaction threshold: ${config.compactionMb}mb`)
  if (config.handoffPath) log(`handoff path: ${config.handoffPath}`)
  if (config.discordWebhookUrl) log('discord: webhook configured')
  log(`locigram: ${config.locigramUrl}`)

  void scanAndMaybeSwitchSession()
  const sessionTimer = setInterval(() => { void scanAndMaybeSwitchSession() }, config.sessionScanMs)

  let projectTimer: NodeJS.Timeout | null = null
  if (config.workspaceRoot && config.obsidianVault) {
    projectTimer = setInterval(() => { void detectProject() }, config.projectDetectMs)
  }

  setupShutdownHandlers(sessionTimer, projectTimer)
}
