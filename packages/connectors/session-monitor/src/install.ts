import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { config } from './config'

function labelForAgent(agentName: string): string {
  return `com.locigram.session-monitor.${agentName}`
}

function unitNameForAgent(agentName: string): string {
  return `locigram-session-monitor-${agentName}.service`
}

export function installMacOS(): void {
  const label = labelForAgent(config.agentName)
  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const plistPath = path.join(plistDir, `${label}.plist`)

  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true })
  }

  // Build optional env vars — only include if set
  const optionalEnvs: string[] = []
  if (config.handoffPath) {
    optionalEnvs.push(`    <key>LOCIGRAM_HANDOFF_PATH</key><string>${config.handoffPath}</string>`)
  }
  if (config.workspaceRoot) {
    optionalEnvs.push(`    <key>OPENCLAW_WORKSPACE_ROOT</key><string>${config.workspaceRoot}</string>`)
  }
  if (config.discordWebhookUrl) {
    optionalEnvs.push(`    <key>DISCORD_WEBHOOK_URL</key><string>${config.discordWebhookUrl}</string>`)
  }
  if (config.obsidianVault) {
    optionalEnvs.push(`    <key>OBSIDIAN_VAULT</key><string>${config.obsidianVault}</string>`)
  }
  if (config.agentType !== 'permanent') {
    optionalEnvs.push(`    <key>LOCIGRAM_AGENT_TYPE</key><string>${config.agentType}</string>`)
  }
  const optionalBlock = optionalEnvs.length > 0 ? '\n' + optionalEnvs.join('\n') : ''

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/locigram-session-monitor</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LOCIGRAM_URL</key><string>${config.locigramUrl}</string>
    <key>LOCIGRAM_API_TOKEN</key><string>${config.apiToken}</string>
    <key>OPENCLAW_AGENT_NAME</key><string>${config.agentName}</string>
    <key>OPENCLAW_AGENTS_DIR</key><string>${config.agentsDir}</string>${optionalBlock}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/locigram-session-monitor-${config.agentName}.log</string>
  <key>StandardErrorPath</key><string>/tmp/locigram-session-monitor-${config.agentName}.error.log</string>
</dict>
</plist>`

  fs.writeFileSync(plistPath, plist)
  console.log(`[install] wrote ${plistPath}`)

  // Unload if previously loaded, then load
  try {
    execSync(`launchctl bootout gui/${process.getuid!()} ${plistPath}`, { stdio: 'pipe' })
  } catch {
    // not loaded — that's fine
  }

  try {
    execSync(`launchctl bootstrap gui/${process.getuid!()} ${plistPath}`, { stdio: 'inherit' })
    console.log(`[install] LaunchAgent loaded: ${label}`)
  } catch (err) {
    console.error(`[install] failed to load LaunchAgent:`, err instanceof Error ? err.message : err)
  }
}

export function installLinux(): void {
  const unitName = unitNameForAgent(config.agentName)
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user')
  const unitPath = path.join(unitDir, unitName)

  if (!fs.existsSync(unitDir)) {
    fs.mkdirSync(unitDir, { recursive: true })
  }

  // Build optional env lines
  const optionalEnvs: string[] = []
  if (config.handoffPath) optionalEnvs.push(`Environment=LOCIGRAM_HANDOFF_PATH=${config.handoffPath}`)
  if (config.workspaceRoot) optionalEnvs.push(`Environment=OPENCLAW_WORKSPACE_ROOT=${config.workspaceRoot}`)
  if (config.discordWebhookUrl) optionalEnvs.push(`Environment=DISCORD_WEBHOOK_URL=${config.discordWebhookUrl}`)
  if (config.obsidianVault) optionalEnvs.push(`Environment=OBSIDIAN_VAULT=${config.obsidianVault}`)
  if (config.agentType !== 'permanent') optionalEnvs.push(`Environment=LOCIGRAM_AGENT_TYPE=${config.agentType}`)
  const optionalBlock = optionalEnvs.length > 0 ? '\n' + optionalEnvs.join('\n') : ''

  const unit = `[Unit]
Description=Locigram Session Monitor (${config.agentName})
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/locigram-session-monitor start
Environment=LOCIGRAM_URL=${config.locigramUrl}
Environment=LOCIGRAM_API_TOKEN=${config.apiToken}
Environment=OPENCLAW_AGENT_NAME=${config.agentName}
Environment=OPENCLAW_AGENTS_DIR=${config.agentsDir}${optionalBlock}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target`

  fs.writeFileSync(unitPath, unit)
  console.log(`[install] wrote ${unitPath}`)

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' })
    execSync(`systemctl --user enable ${unitName}`, { stdio: 'inherit' })
    execSync(`systemctl --user start ${unitName}`, { stdio: 'inherit' })
    console.log(`[install] systemd service enabled and started: ${unitName}`)
  } catch (err) {
    console.error(`[install] failed to start systemd service:`, err instanceof Error ? err.message : err)
  }
}

export function uninstall(): void {
  if (process.platform === 'darwin') {
    const label = labelForAgent(config.agentName)
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
    try {
      execSync(`launchctl bootout gui/${process.getuid!()} ${plistPath}`, { stdio: 'pipe' })
    } catch {
      // not loaded
    }
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath)
      console.log(`[uninstall] removed ${plistPath}`)
    }
  } else {
    const unitName = unitNameForAgent(config.agentName)
    try {
      execSync(`systemctl --user stop ${unitName}`, { stdio: 'pipe' })
      execSync(`systemctl --user disable ${unitName}`, { stdio: 'pipe' })
    } catch {
      // not running
    }
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', unitName)
    if (fs.existsSync(unitPath)) {
      fs.unlinkSync(unitPath)
      console.log(`[uninstall] removed ${unitPath}`)
    }
  }
  console.log(`[uninstall] done (agent: ${config.agentName})`)
}
