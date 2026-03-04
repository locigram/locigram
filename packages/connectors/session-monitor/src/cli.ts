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
    console.log(`[status] OPENCLAW_AGENTS_DIR: ${config.agentsDir}`)
    console.log(`[status] OPENCLAW_AGENT_NAMES: ${config.agentNames.join(', ')}`)

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

Environment variables:
  LOCIGRAM_URL                Locigram server URL (required)
  LOCIGRAM_API_TOKEN          API token (required)
  OPENCLAW_AGENTS_DIR         Path to OpenClaw agents directory (default: ~/.openclaw/agents)
  OPENCLAW_AGENT_NAMES        Comma-separated agent names (default: main)
  LOCIGRAM_PUSH_EVERY_N       Push every N messages (default: 5)
  LOCIGRAM_MAX_TRANSCRIPT_CHARS  Max transcript buffer size (default: 8000)
`)
    break
}
