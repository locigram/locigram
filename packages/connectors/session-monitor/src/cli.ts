#!/usr/bin/env node

import { config, validateConfig } from './config'
import { startDaemon } from './daemon'
import { runComplete } from './complete'
import { installMacOS, installLinux, uninstall } from './install'

const cmd = process.argv[2]

switch (cmd) {
  case 'start':
    validateConfig()
    startDaemon()
    break

  case 'complete':
    validateConfig()
    runComplete().catch((err) => {
      console.error(`[complete] fatal: ${err.message}`)
      process.exit(1)
    })
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
    console.log(`[status] LOCIGRAM_AGENT_TYPE: ${config.agentType}`)
    console.log(`[status] OPENCLAW_AGENTS_DIR: ${config.agentsDir}`)
    console.log(`[status] summary every: ${config.summaryEveryN} messages`)
    console.log(`[status] compaction threshold: ${config.compactionMb}mb`)
    console.log(`[status] handoff path: ${config.handoffPath ?? '(not set)'}`)
    console.log(`[status] active context path: ${config.activeContextPath ?? '(defaults to handoff dir)'}`)
    console.log(`[status] workspace root: ${config.workspaceRoot ?? '(not set)'}`)
    console.log(`[status] discord: ${config.discordWebhookUrl ? 'configured' : '(not set)'}`)

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
  locigram-session-monitor complete    One-shot completion summary (ephemeral agents)
  locigram-session-monitor install     Install as system service (launchd/systemd)
  locigram-session-monitor uninstall   Remove system service
  locigram-session-monitor status      Check config and connectivity

Required environment variables:
  LOCIGRAM_URL                   Locigram server URL
  LOCIGRAM_API_TOKEN             API token

Agent configuration:
  OPENCLAW_AGENT_NAME            Agent name (default: main)
  LOCIGRAM_AGENT_TYPE            Agent type: permanent | ephemeral (default: permanent)
  OPENCLAW_AGENTS_DIR            Path to agents directory (default: ~/.openclaw/agents)

Tuning:
  LOCIGRAM_SUMMARY_EVERY_N       Trigger handoff every N messages (default: 5)
  LOCIGRAM_COMPACTION_MB          File size threshold for handoff (default: 8)

Optional — handoff file:
  LOCIGRAM_HANDOFF_PATH           Write handoff summary to this file
  ACTIVE_CONTEXT_PATH             Write active-context.json here (default: same dir as handoff)
  OPENCLAW_WORKSPACE_ROOT         Workspace root for memory archival
  OBSIDIAN_VAULT                  Obsidian vault path for project detection

Optional — Discord:
  DISCORD_WEBHOOK_URL             Discord webhook URL for posting summaries
`)
    break
}
