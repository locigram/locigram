// ── Source Resolver ──────────────────────────────────────────────────────────
// Resolves a sourceRef string back to the original source material.
// sourceRef format: '<platform>:<type>:<id>[:<sub-id>]'

export interface SourceResolverConfig {
  openclawBasePath?: string    // e.g. '/home/sudobot/.openclaw'
  obsidianVaultPath?: string   // e.g. '/home/sudobot/vault/sudobrain'
  suruDbUrl?: string           // e.g. 'postgresql://surubot:pass@10.10.100.90:30543/suru'
}

export interface SourceResolution {
  sourceRef: string
  platform: string
  resolved: boolean
  material?: string           // The actual content from the source
  contextWindow?: string      // Surrounding context (e.g. neighboring messages/lines)
  metadata?: Record<string, unknown>  // Extra info (subject line, timestamp, etc.)
  urlHint?: string            // Clickable link if available
  error?: string              // Why resolution failed
}

export async function resolveSource(sourceRef: string, config: SourceResolverConfig): Promise<SourceResolution> {
  const [platform, ...parts] = sourceRef.split(':')

  switch (platform) {
    case 'openclaw':
      return resolveOpenClaw(parts, config)
    case 'email':
      return resolveEmail(parts, config)
    case 'halo':
      return resolveHalo(parts)
    case 'teams':
      return resolveTeams(parts)
    case 'calendar':
      return resolveCalendar(parts)
    case 'obsidian':
      return resolveObsidian(parts, config)
    case 'session':
      return resolveSession(parts)
    case 'manual':
      return { sourceRef, platform, resolved: false, error: 'Manual entries have no resolvable source' }
    default:
      return { sourceRef, platform: platform ?? 'unknown', resolved: false, error: `Unknown sourceRef platform: ${platform}` }
  }
}

// ── OpenClaw transcripts ────────────────────────────────────────────────────
// openclaw:<agent>:<session-id>:<msg-index>

async function resolveOpenClaw(parts: string[], config: SourceResolverConfig): Promise<SourceResolution> {
  const [agent, sessionId, msgIndexStr] = parts
  const msgIndex = parseInt(msgIndexStr ?? '0', 10)
  const ref = `openclaw:${parts.join(':')}`

  const transcriptPath = config.openclawBasePath
    ? `${config.openclawBasePath}/agents/${agent}/sessions/${sessionId}.jsonl`
    : null

  if (!transcriptPath) {
    return { sourceRef: ref, platform: 'openclaw', resolved: false, error: 'openclawBasePath not configured' }
  }

  try {
    const { readFileSync } = await import('node:fs')
    const content = readFileSync(transcriptPath, 'utf-8')
    const lines = content.split('\n').filter(Boolean)

    // Extract message range (±5 around target)
    const start = Math.max(0, msgIndex - 5)
    const end = Math.min(lines.length, msgIndex + 6)
    const contextLines = lines.slice(start, end).map(line => {
      try {
        const parsed = JSON.parse(line)
        const role = parsed.role ?? 'unknown'
        const text = parsed.content ?? parsed.text ?? ''
        return `[${role}] ${typeof text === 'string' ? text.slice(0, 500) : JSON.stringify(text).slice(0, 500)}`
      } catch { return line.slice(0, 500) }
    })

    // Target message
    let material = ''
    if (msgIndex < lines.length) {
      try {
        const parsed = JSON.parse(lines[msgIndex])
        material = parsed.content ?? parsed.text ?? lines[msgIndex]
        if (typeof material !== 'string') material = JSON.stringify(material)
      } catch { material = lines[msgIndex] }
    }

    return {
      sourceRef: ref,
      platform: 'openclaw',
      resolved: true,
      material: material.slice(0, 2000),
      contextWindow: contextLines.join('\n'),
      metadata: { agent, sessionId, messageIndex: msgIndex, totalMessages: lines.length },
    }
  } catch (e) {
    return { sourceRef: ref, platform: 'openclaw', resolved: false, error: `Failed to read transcript: ${e}` }
  }
}

// ── Email ───────────────────────────────────────────────────────────────────
// email:comms.emails:<uuid>

async function resolveEmail(parts: string[], config: SourceResolverConfig): Promise<SourceResolution> {
  const uuid = parts[1]
  const ref = `email:${parts.join(':')}`

  if (!uuid) {
    return { sourceRef: ref, platform: 'email', resolved: false, error: 'No email UUID' }
  }

  if (!config.suruDbUrl) {
    return { sourceRef: ref, platform: 'email', resolved: false, error: 'suruDbUrl not configured' }
  }

  try {
    const { default: pg } = await import('pg')
    const client = new pg.Client(config.suruDbUrl)
    await client.connect()
    try {
      const result = await client.query(
        'SELECT subject, from_name, from_address, received_at, LEFT(body_text, 2000) as body FROM comms.emails WHERE id = $1',
        [uuid],
      )

      if (result.rows.length === 0) {
        return { sourceRef: ref, platform: 'email', resolved: false, error: 'Email not found' }
      }

      const row = result.rows[0]
      return {
        sourceRef: ref,
        platform: 'email',
        resolved: true,
        material: row.body ?? '',
        metadata: {
          subject: row.subject,
          from: `${row.from_name} <${row.from_address}>`,
          receivedAt: row.received_at,
        },
      }
    } finally {
      await client.end()
    }
  } catch (e) {
    return { sourceRef: ref, platform: 'email', resolved: false, error: `DB query failed: ${e}` }
  }
}

// ── Obsidian vault ──────────────────────────────────────────────────────────
// obsidian:<relative-path>:<line>

async function resolveObsidian(parts: string[], config: SourceResolverConfig): Promise<SourceResolution> {
  const ref = `obsidian:${parts.join(':')}`
  const lastPart = parts[parts.length - 1]
  let filePath: string
  let lineNum: number | null = null

  if (lastPart?.startsWith('L') && /^L\d+$/.test(lastPart)) {
    lineNum = parseInt(lastPart.slice(1), 10)
    filePath = parts.slice(0, -1).join(':')
  } else {
    filePath = parts.join(':')
  }

  const vaultBase = config.obsidianVaultPath
  if (!vaultBase) {
    return { sourceRef: ref, platform: 'obsidian', resolved: false, error: 'obsidianVaultPath not configured' }
  }

  const fullPath = `${vaultBase}/${filePath}`

  try {
    const { readFileSync } = await import('node:fs')
    const content = readFileSync(fullPath, 'utf-8')
    const lines = content.split('\n')

    if (lineNum !== null) {
      const start = Math.max(0, lineNum - 10)
      const end = Math.min(lines.length, lineNum + 11)
      const contextWindow = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')
      const material = lines[lineNum - 1] ?? ''  // 1-indexed

      return {
        sourceRef: ref,
        platform: 'obsidian',
        resolved: true,
        material,
        contextWindow,
        metadata: { path: filePath, line: lineNum, totalLines: lines.length },
        urlHint: `obsidian://open?vault=sudobrain&file=${encodeURIComponent(filePath)}`,
      }
    }

    return {
      sourceRef: ref,
      platform: 'obsidian',
      resolved: true,
      material: content.slice(0, 2000),
      metadata: { path: filePath, totalLines: lines.length },
      urlHint: `obsidian://open?vault=sudobrain&file=${encodeURIComponent(filePath)}`,
    }
  } catch (e) {
    return { sourceRef: ref, platform: 'obsidian', resolved: false, error: `File not found: ${e}` }
  }
}

// ── Session monitor ─────────────────────────────────────────────────────────
// session:<agent>/<session-id>

async function resolveSession(parts: string[]): Promise<SourceResolution> {
  return {
    sourceRef: `session:${parts.join(':')}`,
    platform: 'session',
    resolved: false,
    error: 'Session summaries are self-contained — the locigram content IS the resolved material',
  }
}

// ── Stubs (not yet implemented) ─────────────────────────────────────────────

async function resolveHalo(parts: string[]): Promise<SourceResolution> {
  return {
    sourceRef: `halo:${parts.join(':')}`,
    platform: 'halo',
    resolved: false,
    error: 'Resolver not yet implemented for HaloPSA tickets',
  }
}

async function resolveTeams(parts: string[]): Promise<SourceResolution> {
  return {
    sourceRef: `teams:${parts.join(':')}`,
    platform: 'teams',
    resolved: false,
    error: 'Resolver not yet implemented for Teams messages',
  }
}

async function resolveCalendar(parts: string[]): Promise<SourceResolution> {
  return {
    sourceRef: `calendar:${parts.join(':')}`,
    platform: 'calendar',
    resolved: false,
    error: 'Resolver not yet implemented for calendar events',
  }
}
