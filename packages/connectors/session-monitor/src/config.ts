import * as os from 'os'
import * as path from 'path'

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

export const config = {
  // Required
  locigramUrl:      process.env.LOCIGRAM_URL ?? '',
  apiToken:         process.env.LOCIGRAM_API_TOKEN ?? '',

  // Agent
  agentName:        process.env.OPENCLAW_AGENT_NAME ?? process.env.AGENT_NAME ?? 'main',
  agentType:        (process.env.LOCIGRAM_AGENT_TYPE ?? 'permanent') as 'permanent' | 'ephemeral',
  agentsDir:        process.env.OPENCLAW_AGENTS_DIR ?? expandHome('~/.openclaw/agents'),

  // Tuning
  summaryEveryN:    Number(process.env.LOCIGRAM_SUMMARY_EVERY_N ?? '5'),
  compactionMb:     Number(process.env.LOCIGRAM_COMPACTION_MB ?? '8'),
  watchIntervalMs:  2000,
  sessionScanMs:    30_000,
  dumpCooldownMs:   10 * 60_000,
  projectDetectMs:  5 * 60_000,

  // Optional — handoff file
  handoffPath:      process.env.LOCIGRAM_HANDOFF_PATH ?? null as string | null,
  activeContextPath: process.env.ACTIVE_CONTEXT_PATH ?? null as string | null,
  workspaceRoot:    process.env.OPENCLAW_WORKSPACE_ROOT ?? null as string | null,
  obsidianVault:    process.env.OBSIDIAN_VAULT ?? null as string | null,

  // Optional — Discord
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? null as string | null,
}

export function validateConfig(): void {
  if (!config.locigramUrl) {
    console.error('[session-monitor] LOCIGRAM_URL is required')
    process.exit(1)
  }
  if (!config.apiToken) {
    console.error('[session-monitor] LOCIGRAM_API_TOKEN is required')
    process.exit(1)
  }
}
