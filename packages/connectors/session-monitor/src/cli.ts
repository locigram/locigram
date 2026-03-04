#!/usr/bin/env node

import { config, validateConfig } from './config'
import { startDaemon } from './daemon'
import { installMacOS, installLinux, uninstall } from './install'

const cmd = process.argv[2]

switch (cmd) {
  case 'start':
    validateConfig()
    startDaemon()
    break

  case 'install':
    validateConfig()
    if (process.platform === 'darwin') {
      installMacOS()
    } else {
      installLinux()
    }
    break

  case 'uninstall':
    uninstall()
    break

  case 'status': {
    console.log(`[status] platform: ${process.platform}`)
    console.log(`[status] LOCIGRAM_URL: ${config.locigramUrl || '(not set)'}`)
    console.log(`[status] LOCIGRAM_API_TOKEN: ${config.apiToken ? '***' : '(not set)'}`)
    console.log(`[status] OPENCLAW_AGENT_NAME: ${config.agentName}`)
    console.log(`[status] OPENCLAW_AGENTS_DIR: ${config.agentsDir}`)
    console.log(`[status] summary every: ${config.summaryEveryN} messages`)
    console.log(`[status] compaction threshold: ${config.compactionMb}mb`)
    console.log(`[status] handoff path: ${config.handoffPath ?? '(not set)'}`)
    console.log(`[status] workspace root: ${config.workspaceRoot ?? '(not set)'}`)
    console.log(`[status] discord: ${config.discordToken ? 'configured' : '(not set)'}`)

    // Test connectivity
    if (config.locigramUrl) {
      import('http').then(http => {
        import('https').then(httpsmod => {
          const parsed = new URL(`${config.locigramUrl}/api/health`)
          const mod = parsed.protocol === 'https:' ? httpsmod : http
          const req = mod.request(parsed, { method: 'GET', timeout: 5000 }, (res) => {
            console.log(`[status] Locigram health check: ${res.statusCode}`)
          })
          req.on('error', (err) => {
            console.error(`[status] Locigram unreachable: ${err.message}`)
          })
          req.end()
        })
      })
    }
    break
  }

  default:
    console.log(`locigram-session-monitor — OpenClaw session monitor for Locigram

Usage:
  locigram-session-monitor start       Run daemon (blocking)
  locigram-session-monitor install     Install as system service (launchd/systemd)
  locigram-session-monitor uninstall   Remove system service
  locigram-session-monitor status      Check config and connectivity

Required environment variables:
  LOCIGRAM_URL                   Locigram server URL
  LOCIGRAM_API_TOKEN             API token

Agent configuration:
  OPENCLAW_AGENT_NAME            Agent name (default: main)
  OPENCLAW_AGENTS_DIR            Path to agents directory (default: ~/.openclaw/agents)

Tuning:
  LOCIGRAM_SUMMARY_EVERY_N       Trigger handoff every N messages (default: 5)
  LOCIGRAM_COMPACTION_MB          File size threshold for handoff (default: 8)

Optional — handoff file:
  LOCIGRAM_HANDOFF_PATH           Write handoff summary to this file
  OPENCLAW_WORKSPACE_ROOT         Workspace root for memory archival
  OBSIDIAN_VAULT                  Obsidian vault path for project detection

Optional — Discord:
  DISCORD_BOT_TOKEN               Discord bot token for posting summaries
  SESSION_MONITOR_DISCORD_CHANNEL Discord channel ID
`)
    break
}
