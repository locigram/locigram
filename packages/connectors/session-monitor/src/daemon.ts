import * as fs from 'fs'
import * as path from 'path'
import { config } from './config'
import { pushToLocigram } from './ingest'

interface AgentState {
  filePath: string
  fileSize: number
  newMessageCount: number
  transcriptBuffer: string
  sessionId: string
}

function findNewestJsonl(sessionsDir: string): string | null {
  if (!fs.existsSync(sessionsDir)) return null
  const files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
  return files.length > 0 ? path.join(sessionsDir, files[0].name) : null
}

function extractSessionId(filePath: string): string {
  const base = path.basename(filePath, '.jsonl')
  const date = new Date().toISOString().slice(0, 10)
  return `${date}-${base}`
}

function parseJsonlLines(text: string): Array<{ role?: string; type?: string; content?: string; message?: string }> {
  const lines: Array<{ role?: string; type?: string; content?: string; message?: string }> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      lines.push(JSON.parse(trimmed))
    } catch {
      // skip malformed lines
    }
  }
  return lines
}

function isConversationMessage(entry: { role?: string; type?: string }): boolean {
  // Include user and assistant messages, skip tool calls/results
  if (entry.type === 'tool_use' || entry.type === 'tool_result') return false
  return entry.role === 'user' || entry.role === 'assistant'
}

function formatMessage(entry: { role?: string; content?: string; message?: string }): string {
  const role = entry.role ?? 'unknown'
  const text = entry.content ?? entry.message ?? ''
  return `[${role}] ${typeof text === 'string' ? text : JSON.stringify(text)}`
}

export function startDaemon(): void {
  console.log(`[session-monitor] starting daemon`)
  console.log(`[session-monitor] agents dir: ${config.agentsDir}`)
  console.log(`[session-monitor] watching agents: ${config.agentNames.join(', ')}`)
  console.log(`[session-monitor] push every ${config.pushEveryN} messages`)
  console.log(`[session-monitor] max transcript chars: ${config.maxTranscriptChars}`)

  const states = new Map<string, AgentState>()

  for (const agentName of config.agentNames) {
    const sessionsDir = path.join(config.agentsDir, agentName, 'sessions')
    const jsonlPath = findNewestJsonl(sessionsDir)

    if (!jsonlPath) {
      console.log(`[session-monitor] no session files found for agent "${agentName}" in ${sessionsDir}`)
      continue
    }

    const stat = fs.statSync(jsonlPath)
    const state: AgentState = {
      filePath: jsonlPath,
      fileSize: stat.size,
      newMessageCount: 0,
      transcriptBuffer: '',
      sessionId: extractSessionId(jsonlPath),
    }
    states.set(agentName, state)

    console.log(`[session-monitor] watching ${agentName}: ${jsonlPath}`)

    // Poll for file changes every 2 seconds
    fs.watchFile(jsonlPath, { interval: 2000 }, (curr, prev) => {
      if (curr.size <= prev.size) return
      onFileGrowth(agentName, state, prev.size, curr.size)
    })
  }

  // Also periodically check for new session files
  setInterval(() => {
    for (const agentName of config.agentNames) {
      const sessionsDir = path.join(config.agentsDir, agentName, 'sessions')
      const newestPath = findNewestJsonl(sessionsDir)
      if (!newestPath) continue

      const existing = states.get(agentName)
      if (existing && existing.filePath === newestPath) continue

      // New session file detected — switch to it
      if (existing) {
        fs.unwatchFile(existing.filePath)
      }

      const stat = fs.statSync(newestPath)
      const state: AgentState = {
        filePath: newestPath,
        fileSize: stat.size,
        newMessageCount: 0,
        transcriptBuffer: '',
        sessionId: extractSessionId(newestPath),
      }
      states.set(agentName, state)

      console.log(`[session-monitor] new session for ${agentName}: ${newestPath}`)

      fs.watchFile(newestPath, { interval: 2000 }, (curr, prev) => {
        if (curr.size <= prev.size) return
        onFileGrowth(agentName, state, prev.size, curr.size)
      })
    }
  }, 30_000) // check every 30s

  console.log(`[session-monitor] daemon running`)
}

function onFileGrowth(agentName: string, state: AgentState, prevSize: number, currSize: number): void {
  try {
    const fd = fs.openSync(state.filePath, 'r')
    const buf = Buffer.alloc(currSize - prevSize)
    fs.readSync(fd, buf, 0, buf.length, prevSize)
    fs.closeSync(fd)

    const newText = buf.toString('utf-8')
    const entries = parseJsonlLines(newText)
    const messages = entries.filter(isConversationMessage)

    if (messages.length === 0) return

    for (const msg of messages) {
      const formatted = formatMessage(msg)
      state.transcriptBuffer += formatted + '\n'
      state.newMessageCount++
    }

    // Trim buffer to maxTranscriptChars (keep the tail)
    if (state.transcriptBuffer.length > config.maxTranscriptChars) {
      state.transcriptBuffer = state.transcriptBuffer.slice(-config.maxTranscriptChars)
    }

    state.fileSize = currSize

    // Push every N new messages
    if (state.newMessageCount >= config.pushEveryN) {
      state.newMessageCount = 0
      pushToLocigram(agentName, state.sessionId, state.transcriptBuffer)
    }
  } catch (err) {
    console.error(`[session-monitor] error reading ${state.filePath}:`, err instanceof Error ? err.message : err)
  }
}
