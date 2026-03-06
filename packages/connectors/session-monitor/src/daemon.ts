import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { config } from './config'
import { pushToLocigram, flushSyncReport } from './ingest'

const LOG_PREFIX = '[session-monitor]'
const SECTION_BREAK_EVERY_N = 15

// ── Types ────────────────────────────────────────────────────────────────────

interface StructuredContext {
  currentTask: string
  currentProject: string
  pendingActions: string[]
  recentDecisions: string[]
  blockers: string[]
  activeAgents: string[]
  domain: string
}

interface ActiveContextJson extends StructuredContext {
  _autoUpdated: string
  _sessionId: string
  _finalSnapshot?: boolean
}

interface LlmResult {
  narrative: string
  structured: StructuredContext | null
}

interface AgentWatcherState {
  agentName: string
  currentSessionPath: string | null
  currentSessionId: string
  lastReadPosition: number
  pendingLineBuffer: string
  parsedMessageCount: number
  sectionNumber: number
  lastHandoffAt: number
  lastSummaryMessageCount: number
  lastSessionSwitchAt: number
  lastStructured: StructuredContext | null
  pendingActionHistory: Map<string, number>
}

// ── State ────────────────────────────────────────────────────────────────────

const sessionWatchers = new Map<string, AgentWatcherState>()
let shuttingDown = false

// ── Logging ──────────────────────────────────────────────────────────────────

function log(message: string, agentName?: string): void {
  console.log(`${LOG_PREFIX}[${agentName ?? 'system'}] ${message}`)
}

function warn(message: string, agentName?: string): void {
  console.warn(`${LOG_PREFIX}[${agentName ?? 'system'}] ${message}`)
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

// ── Active context path resolution ───────────────────────────────────────────

function resolveActiveContextPath(): string | null {
  if (config.activeContextPath) return config.activeContextPath
  if (config.handoffPath) return path.join(path.dirname(config.handoffPath), 'active-context.json')
  return null
}

// ── Session file discovery ───────────────────────────────────────────────────

async function findAllActiveSessions(agentName: string): Promise<string[]> {
  const sessionsDir = path.join(config.agentsDir, agentName, 'sessions')
  let files: string[] = []
  try {
    files = await fsp.readdir(sessionsDir)
  } catch { return [] }

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  const active: string[] = []
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const full = path.join(sessionsDir, file)
    try {
      const st = await fsp.stat(full)
      if (st.mtimeMs > twoHoursAgo && st.size > 0) active.push(full)
    } catch { /* skip */ }
  }
  return active
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

async function appendTranscript(entries: string[], state: AgentWatcherState): Promise<void> {
  if (entries.length === 0) return
  for (const _entry of entries) {
    state.parsedMessageCount += 1
    if (state.parsedMessageCount > 1 && (state.parsedMessageCount - state.lastSummaryMessageCount) >= config.summaryEveryN) {
      state.lastSummaryMessageCount = state.parsedMessageCount
      setImmediate(() => triggerHandoffDump(0, state, 'message-count').catch(() => {}))
    }
  }
  log(`new messages parsed: ${entries.length}`, state.agentName)
}

async function processSessionGrowth(filePath: string, size: number, state: AgentWatcherState): Promise<void> {
  if (size < state.lastReadPosition) { state.lastReadPosition = 0; state.pendingLineBuffer = '' }
  const chunk = await readIncrementalChunk(filePath, state.lastReadPosition, size)
  state.lastReadPosition = size
  if (!chunk) return
  const combined = state.pendingLineBuffer + chunk
  const lines = combined.split(/\r?\n/)
  state.pendingLineBuffer = lines.pop() ?? ''
  const parsed: string[] = []
  for (const line of lines) {
    const formatted = parseTranscriptLine(line)
    if (formatted) parsed.push(formatted)
  }
  await appendTranscript(parsed, state)
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

async function callLlm(prompt: string): Promise<LlmResult | null> {
  try {
    const res = await httpPostJson(
      `${config.locigramUrl}/api/internal/summarize`,
      { prompt, maxTokens: 1200 },
      { 'Authorization': `Bearer ${config.apiToken}` },
      150_000,
    )
    if (res.status >= 200 && res.status < 300) {
      const narrative = res.data?.narrative ?? res.data?.summary ?? null
      const structured = res.data?.structured ?? null
      if (narrative) {
        return { narrative, structured }
      }
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

// ── Active context JSON writing ──────────────────────────────────────────────

async function writeActiveContext(structured: StructuredContext | null, state: AgentWatcherState, finalSnapshot = false): Promise<void> {
  // Only write active-context.json for the primary agent
  if (state.agentName !== config.agentName) return

  const contextPath = resolveActiveContextPath()
  if (!contextPath) return

  const context: ActiveContextJson = {
    currentTask: structured?.currentTask ?? 'unknown',
    currentProject: structured?.currentProject ?? 'unknown',
    pendingActions: structured?.pendingActions ?? [],
    recentDecisions: structured?.recentDecisions ?? [],
    blockers: structured?.blockers ?? [],
    activeAgents: structured?.activeAgents ?? [],
    domain: structured?.domain ?? 'general',
    _autoUpdated: new Date().toISOString(),
    _sessionId: state.currentSessionId,
  }

  if (finalSnapshot) {
    context._finalSnapshot = true
  }

  await fsp.mkdir(path.dirname(contextPath), { recursive: true })
  await fsp.writeFile(contextPath, JSON.stringify(context, null, 2), 'utf8')
  log(`active-context.json written${finalSnapshot ? ' (final snapshot)' : ''}: ${contextPath}`, state.agentName)
}

// ── Pending action drift detection ───────────────────────────────────────────

function trackPendingActionDrift(structured: StructuredContext | null, state: AgentWatcherState): void {
  if (!structured?.pendingActions?.length) return

  const currentActions = new Set(structured.pendingActions)
  const newHistory = new Map<string, number>()

  for (const action of currentActions) {
    const prev = state.pendingActionHistory.get(action) ?? 0
    const count = prev + 1
    newHistory.set(action, count)
    if (count >= 3) {
      warn(`stale pending action: "${action}" unchanged for ${count} handoffs`, state.agentName)
    }
  }

  state.pendingActionHistory = newHistory
}

// ── Handoff dump ─────────────────────────────────────────────────────────────

async function triggerHandoffDump(triggerSizeMb: number, state: AgentWatcherState, triggerReason = 'file-size'): Promise<void> {
  let condensedTranscript = ''
  if (state.currentSessionPath) {
    condensedTranscript = await readLastJsonlMessages(state.currentSessionPath, 150)
    if (condensedTranscript) log('handoff: using jsonl as source (' + condensedTranscript.length + ' chars)', state.agentName)
  }
  if (!condensedTranscript) {
    warn('handoff trigger skipped: no transcript available', state.agentName)
    return
  }

  // Task-aware summarization prompt with domain detection
  const prompt = [
    `You are summarizing an ongoing AI assistant session for agent "${state.agentName}" for context handoff.`,
    'Read the transcript below and extract:',
    '1. Current task/project (1 sentence \u2014 what is being worked on RIGHT NOW)',
    '2. Key decisions made this session (bullet list, max 15, most recent first)',
    '3. Files/code changed (bullet list with what changed)',
    '4. What was being worked on in the most recent messages',
    '5. Immediate next steps (ordered list)',
    '',
    'Detect the primary domain of the work from the transcript:',
    '- infrastructure: server setup, networking, deployment, Docker, K8s, CI/CD',
    '- coding: writing/debugging code, implementing features, refactoring',
    '- email: email management, correspondence, communication',
    '- business/finance: invoicing, contracts, client management, accounting',
    '- general: everything else',
    'Prepend your summary with: **Domain:** <detected domain>',
    '',
    'Keep it under 600 words. Be specific. Focus on recent activity but capture the full arc.',
    '',
    'TRANSCRIPT (beginning + recent):',
    condensedTranscript,
  ].join('\n')

  const llmResult = await callLlm(prompt)
  let summary: string
  let structured: StructuredContext | null = null

  if (llmResult) {
    summary = llmResult.narrative
    structured = llmResult.structured
  } else {
    warn('handoff summary unavailable; writing raw transcript tail as fallback', state.agentName)
    const tail = condensedTranscript.split('\n').slice(-150).join('\n')
    summary = `## Raw Transcript Tail (last 150 lines \u2014 LLM unavailable)\n\n${tail}`
  }

  const now = new Date()

  // Write handoff file if configured (primary agent only)
  if (config.handoffPath && state.agentName === config.agentName) {
    const out = [
      `# Live Session Handoff \u2014 ${state.agentName}`,
      `_Updated: ${formatTimestamp(now)}_`,
      `_Trigger: ${triggerReason === 'file-size' ? `file size ${triggerSizeMb.toFixed(2)}mb` : `every ${config.summaryEveryN} messages (msg #${state.parsedMessageCount})`}_`,
      '',
      summary, '',
    ].join('\n')
    await fsp.writeFile(config.handoffPath, out, 'utf8')
    log(`handoff dump written (${triggerReason}): ${config.handoffPath}`, state.agentName)
  }

  // Write active-context.json (primary agent only — checked inside)
  state.lastStructured = structured
  await writeActiveContext(structured, state)

  // Track pending action drift
  trackPendingActionDrift(structured, state)

  state.lastHandoffAt = Date.now()

  // Post summary to Discord webhook if configured
  if (config.discordWebhookUrl) {
    try {
      const truncated = summary.length > 1800 ? summary.slice(0, 1800) + '\n\u2026*(truncated)*' : summary
      const msg = `**Session Handoff \u2014 ${state.agentName}**\n_${formatTimestamp(now)} \u00b7 ${triggerReason}_\n\n${truncated}`
      await httpPostJson(config.discordWebhookUrl, { content: msg }, {})
      log('handoff posted to Discord', state.agentName)
    } catch (e: any) {
      warn(`Discord post failed: ${e.message}`, state.agentName)
    }
  }

  // Push session summary to Locigram under hierarchical locus
  try {
    const sessionLocus = `agent/${state.agentName}/session/${state.currentSessionId}`
    await pushToLocigram(state.agentName, state.currentSessionId, summary, now, sessionLocus)
    log('handoff pushed to Locigram (session)', state.agentName)
  } catch (e: any) {
    warn(`Locigram push error (session): ${e.message}`, state.agentName)
  }

  // Push active context (structured JSON) under context locus
  if (structured) {
    try {
      const contextLocus = `agent/${state.agentName}/context`
      const contextPayload = JSON.stringify({
        ...structured,
        _autoUpdated: now.toISOString(),
        _sessionId: state.currentSessionId,
        _agentType: config.agentType,
      })
      await pushToLocigram(state.agentName, state.currentSessionId, contextPayload, now, contextLocus)
      log('handoff pushed to Locigram (context)', state.agentName)
    } catch (e: any) {
      warn(`Locigram push error (context): ${e.message}`, state.agentName)
    }
  }
}

// ── Size-based handoff trigger ───────────────────────────────────────────────

async function maybeTriggerHandoff(sessionSizeBytes: number, state: AgentWatcherState): Promise<void> {
  const thresholdBytes = config.compactionMb * 1024 * 1024
  if (sessionSizeBytes < thresholdBytes) return
  const elapsed = Date.now() - state.lastHandoffAt
  if (elapsed < config.dumpCooldownMs) return
  const sizeMb = sessionSizeBytes / (1024 * 1024)
  log(`handoff trigger: file size ${sizeMb.toFixed(2)}mb`, state.agentName)
  await triggerHandoffDump(sizeMb, state)
}

// ── Handoff archival on session switch ────────────────────────────────────────

async function archiveHandoffOnSessionSwitch(state: AgentWatcherState): Promise<void> {
  // Only archive for primary agent (handoff file is shared)
  if (state.agentName !== config.agentName) return
  if (!config.handoffPath) return
  try {
    const existing = await fsp.readFile(config.handoffPath, 'utf8')
    if (!existing.trim()) return
    const now = new Date()
    const ts = formatTimestamp(now).replace(/[/:]/g, '-').replace(/\s/g, '_')
    const archivePath = config.handoffPath.replace('.md', `-archived-${ts}.md`)
    await fsp.writeFile(archivePath, existing, 'utf8')
    log(`archived pre-compaction handoff to ${archivePath}`, state.agentName)
    // Also append to today's memory flush file if workspace configured
    if (config.workspaceRoot) {
      const memoryDir = path.join(config.workspaceRoot, 'memory')
      await fsp.mkdir(memoryDir, { recursive: true })
      const dateStamp = formatDate(now)
      const memoryPath = path.join(memoryDir, `${dateStamp}.md`)
      const separator = `\n\n---\n\n# Session Monitor Handoff Archive \u2014 ${formatTimestamp(now)}\n\n`
      await fsp.appendFile(memoryPath, separator + existing, 'utf8')
      log(`appended handoff to memory flush file ${memoryPath}`, state.agentName)
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') warn(`failed to archive handoff: ${e.message}`, state.agentName)
  }
}

// ── Project detection ────────────────────────────────────────────────────────
// DISABLED: Auto-creating project stubs from LLM output produced 937 junk files.
// The LLM extracted code snippets and log lines as "project names".
// If re-enabled, needs: strict name validation, allowlist matching, human approval.

async function detectProject(_state: AgentWatcherState): Promise<void> {
  // no-op — disabled 2026-03-06
}

// ── Startup reconciliation ───────────────────────────────────────────────────

async function startupReconciliation(): Promise<void> {
  const contextPath = resolveActiveContextPath()
  if (!contextPath || !config.handoffPath) return

  let contextJson: ActiveContextJson | null = null
  let handoffText: string | null = null

  try {
    const raw = await fsp.readFile(contextPath, 'utf8')
    contextJson = JSON.parse(raw)
  } catch { /* no active-context.json yet */ }

  try {
    handoffText = await fsp.readFile(config.handoffPath, 'utf8')
  } catch { /* no handoff file yet */ }

  if (!contextJson || !handoffText) return

  const task = contextJson.currentTask
  if (task && task !== 'unknown' && !handoffText.includes(task)) {
    warn(`context drift detected: JSON says "${task}" but narrative differs`)
  }
}

// ── Multi-agent awareness ────────────────────────────────────────────────────

async function logFleetStatus(): Promise<void> {
  try {
    const entries = await fsp.readdir(config.agentsDir)
    let agentCount = 0
    for (const entry of entries) {
      const sessionsDir = path.join(config.agentsDir, entry, 'sessions')
      try { await fsp.access(sessionsDir, fs.constants.F_OK); agentCount++ } catch { /* skip */ }
    }
    log(`fleet: ${sessionWatchers.size} active sessions across ${agentCount} agent dirs`)
  } catch {
    log('fleet: unable to scan agents dir')
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

async function sendHeartbeat(state: AgentWatcherState): Promise<void> {
  try {
    const res = await httpPostJson(
      `${config.locigramUrl}/api/agents/${encodeURIComponent(state.agentName)}/heartbeat`,
      { agentType: config.agentType, status: 'alive' },
      { 'Authorization': `Bearer ${config.apiToken}` },
    )
    if (res.status >= 200 && res.status < 300) {
      log('heartbeat sent', state.agentName)
    } else {
      warn(`heartbeat failed: ${res.status}`, state.agentName)
    }
  } catch (e: any) {
    warn(`heartbeat error: ${e.message}`, state.agentName)
  }
}

// ── Session attachment ───────────────────────────────────────────────────────

async function attachSessionFile(sessionPath: string, state: AgentWatcherState): Promise<void> {
  // Session continuity awareness
  const now = Date.now()
  const timeSinceLastSwitch = now - state.lastSessionSwitchAt
  const CONTINUITY_WINDOW_MS = 15 * 60 * 1000  // 15 minutes

  if (state.currentSessionPath && state.currentSessionPath !== sessionPath) {
    if (state.lastSessionSwitchAt > 0 && timeSinceLastSwitch < CONTINUITY_WINDOW_MS) {
      log('session continuity: resuming within 15min window, preserving context', state.agentName)
      // Skip archive/reset — just update the session path
    } else {
      await archiveHandoffOnSessionSwitch(state)
    }
  }

  if (state.currentSessionPath) fs.unwatchFile(state.currentSessionPath)
  state.currentSessionPath = sessionPath
  state.currentSessionId = deriveSessionId(sessionPath)
  state.lastReadPosition = 0
  state.pendingLineBuffer = ''
  state.lastSessionSwitchAt = now
  log(`session file found: ${sessionPath}`, state.agentName)
  await ensureTranscriptDir()
  const initialStat = await fsp.stat(sessionPath)
  state.lastReadPosition = initialStat.size
  state.lastSummaryMessageCount = 0
  state.parsedMessageCount = 0
  state.sectionNumber = 1
  log(`watching session; skipping ${(initialStat.size / 1024 / 1024).toFixed(1)}mb of existing history`, state.agentName)
  fs.watchFile(sessionPath, { interval: config.watchIntervalMs }, async (curr) => {
    if (shuttingDown) return
    try {
      await processSessionGrowth(sessionPath, curr.size, state)
      await maybeTriggerHandoff(curr.size, state)
    } catch (error) { warn(`watch error: ${String(error)}`, state.agentName) }
  })
}

// ── Dynamic fleet discovery ──────────────────────────────────────────────────

async function discoverAndSyncSessions(): Promise<void> {
  let agentDirs: string[] = []
  try {
    agentDirs = await fsp.readdir(config.agentsDir)
  } catch { return }

  const activeKeys = new Set<string>()

  for (const agentName of agentDirs) {
    const sessionsDir = path.join(config.agentsDir, agentName, 'sessions')
    try { await fsp.access(sessionsDir) } catch { continue }

    const activePaths = await findAllActiveSessions(agentName)
    for (const sessionPath of activePaths) {
      const sessionId = deriveSessionId(sessionPath)
      const key = `${agentName}:${sessionId}`
      activeKeys.add(key)

      if (!sessionWatchers.has(key)) {
        const state: AgentWatcherState = {
          agentName,
          currentSessionPath: null,
          currentSessionId: sessionId,
          lastReadPosition: 0,
          pendingLineBuffer: '',
          parsedMessageCount: 0,
          sectionNumber: 1,
          lastHandoffAt: 0,
          lastSummaryMessageCount: 0,
          lastSessionSwitchAt: 0,
          lastStructured: null,
          pendingActionHistory: new Map(),
        }
        sessionWatchers.set(key, state)
        log(`new session discovered: ${agentName}/${sessionId}`, agentName)
        try { await attachSessionFile(sessionPath, state) }
        catch (error) { warn(`failed to attach ${sessionPath}: ${String(error)}`, agentName) }
      }
    }
  }

  // Prune stale sessions
  for (const [key, state] of sessionWatchers.entries()) {
    if (!activeKeys.has(key)) {
      log(`session went stale, removing: ${key}`, state.agentName)
      if (state.currentSessionPath) {
        fs.unwatchFile(state.currentSessionPath)
        try {
          const sizeMb = (await fsp.stat(state.currentSessionPath)).size / (1024 * 1024)
          await triggerHandoffDump(sizeMb, state, 'session-stale')
        } catch { /* best effort */ }
      }
      sessionWatchers.delete(key)
    }
  }
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

function setupShutdownHandlers(sessionTimer: NodeJS.Timeout, projectTimer: NodeJS.Timeout | null, heartbeatTimer?: NodeJS.Timeout): void {
  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log(`received ${signal}; final handoff dump for all agents...`)
    clearInterval(sessionTimer)
    if (projectTimer) clearInterval(projectTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)

    for (const state of sessionWatchers.values()) {
      if (state.currentSessionPath) fs.unwatchFile(state.currentSessionPath)
      try {
        const sizeMb = state.currentSessionPath ? (await fsp.stat(state.currentSessionPath)).size / (1024 * 1024) : 0
        await triggerHandoffDump(sizeMb, state, 'shutdown')
      } catch (error) { warn(`shutdown handoff failed: ${String(error)}`, state.agentName) }

      try {
        await writeActiveContext(state.lastStructured, state, true)
      } catch (error) { warn(`final snapshot write failed: ${String(error)}`, state.agentName) }
    }

    // Flush final sync report to connector
    try { await flushSyncReport() } catch { /* best effort */ }

    process.exit(0)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function startDaemon(): void {
  log('daemon started')
  log('mode: dynamic discovery — all agents, all active sessions, auto-detected')
  log(`summary every ${config.summaryEveryN} messages`)
  log(`compaction threshold: ${config.compactionMb}mb`)
  if (config.handoffPath) log(`handoff path: ${config.handoffPath}`)
  const contextPath = resolveActiveContextPath()
  if (contextPath) log(`active-context path: ${contextPath}`)
  if (config.discordWebhookUrl) log('discord: webhook configured')
  log(`locigram: ${config.locigramUrl}`)

  void startupReconciliation()
  void discoverAndSyncSessions()

  // Discovery timer — scans all agent dirs every 30s
  const sessionTimer = setInterval(() => {
    void discoverAndSyncSessions()
  }, config.sessionScanMs)

  // Project detection for all active sessions
  let projectTimer: NodeJS.Timeout | null = null
  if (config.workspaceRoot && config.obsidianVault) {
    projectTimer = setInterval(() => {
      for (const state of sessionWatchers.values()) {
        void detectProject(state)
      }
    }, config.projectDetectMs)
  }

  // Heartbeat per unique agent name (deduplicated across sessions)
  const HEARTBEAT_INTERVAL_MS = 10 * 60_000
  const sendAllHeartbeats = async (): Promise<void> => {
    const seen = new Set<string>()
    for (const state of sessionWatchers.values()) {
      if (!seen.has(state.agentName)) {
        seen.add(state.agentName)
        void sendHeartbeat(state)
      }
    }
  }
  void sendAllHeartbeats()
  const heartbeatTimer = setInterval(() => { void sendAllHeartbeats() }, HEARTBEAT_INTERVAL_MS)

  setupShutdownHandlers(sessionTimer, projectTimer, heartbeatTimer)
}
