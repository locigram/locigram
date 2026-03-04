import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { config } from './config'

const LABEL = 'com.locigram.session-monitor'

export function installMacOS(): void {
  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const plistPath = path.join(plistDir, `${LABEL}.plist`)

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
  if (config.discordToken) {
    optionalEnvs.push(`    <key>DISCORD_BOT_TOKEN</key><string>${config.discordToken}</string>`)
  }
  if (config.discordChannel) {
    optionalEnvs.push(`    <key>SESSION_MONITOR_DISCORD_CHANNEL</key><string>${config.discordChannel}</string>`)
  }
  if (config.obsidianVault) {
    optionalEnvs.push(`    <key>OBSIDIAN_VAULT</key><string>${config.obsidianVault}</string>`)
  }
  const optionalBlock = optionalEnvs.length > 0 ? '\n' + optionalEnvs.join('\n') : ''

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
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
  <key>StandardOutPath</key><string>/tmp/locigram-session-monitor.log</string>
  <key>StandardErrorPath</key><string>/tmp/locigram-session-monitor.error.log</string>
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
    console.log(`[install] LaunchAgent loaded`)
  } catch (err) {
    console.error(`[install] failed to load LaunchAgent:`, err instanceof Error ? err.message : err)
  }
}

export function installLinux(): void {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user')
  const unitPath = path.join(unitDir, 'locigram-session-monitor.service')

  if (!fs.existsSync(unitDir)) {
    fs.mkdirSync(unitDir, { recursive: true })
  }

  // Build optional env lines
  const optionalEnvs: string[] = []
  if (config.handoffPath) optionalEnvs.push(`Environment=LOCIGRAM_HANDOFF_PATH=${config.handoffPath}`)
  if (config.workspaceRoot) optionalEnvs.push(`Environment=OPENCLAW_WORKSPACE_ROOT=${config.workspaceRoot}`)
  if (config.discordToken) optionalEnvs.push(`Environment=DISCORD_BOT_TOKEN=${config.discordToken}`)
  if (config.discordChannel) optionalEnvs.push(`Environment=SESSION_MONITOR_DISCORD_CHANNEL=${config.discordChannel}`)
  if (config.obsidianVault) optionalEnvs.push(`Environment=OBSIDIAN_VAULT=${config.obsidianVault}`)
  const optionalBlock = optionalEnvs.length > 0 ? '\n' + optionalEnvs.join('\n') : ''

  const unit = `[Unit]
Description=Locigram Session Monitor
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
    execSync('systemctl --user enable locigram-session-monitor.service', { stdio: 'inherit' })
    execSync('systemctl --user start locigram-session-monitor.service', { stdio: 'inherit' })
    console.log(`[install] systemd service enabled and started`)
  } catch (err) {
    console.error(`[install] failed to start systemd service:`, err instanceof Error ? err.message : err)
  }
}

export function uninstall(): void {
  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
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
    try {
      execSync('systemctl --user stop locigram-session-monitor.service', { stdio: 'pipe' })
      execSync('systemctl --user disable locigram-session-monitor.service', { stdio: 'pipe' })
    } catch {
      // not running
    }
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'locigram-session-monitor.service')
    if (fs.existsSync(unitPath)) {
      fs.unlinkSync(unitPath)
      console.log(`[uninstall] removed ${unitPath}`)
    }
  }
  console.log(`[uninstall] done`)
}
