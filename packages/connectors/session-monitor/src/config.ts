import * as os from 'os'
import * as path from 'path'

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
  return p
}

export const config = {
  locigramUrl:         process.env.LOCIGRAM_URL ?? '',
  apiToken:            process.env.LOCIGRAM_API_TOKEN ?? '',
  agentsDir:           process.env.OPENCLAW_AGENTS_DIR ?? expandHome('~/.openclaw/agents'),
  agentNames:          (process.env.OPENCLAW_AGENT_NAMES ?? 'main').split(',').map(s => s.trim()),
  pushEveryN:          Number(process.env.LOCIGRAM_PUSH_EVERY_N ?? '5'),
  maxTranscriptChars:  Number(process.env.LOCIGRAM_MAX_TRANSCRIPT_CHARS ?? '8000'),
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
