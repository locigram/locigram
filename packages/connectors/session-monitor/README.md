# @locigram/session-monitor

A daemon that watches [OpenClaw](https://openclaw.ai) agent session files and pushes structured memory snapshots to your [Locigram](https://locigram.ai) palace.

Every N messages, it:
1. Reads the active session transcript
2. Calls Locigram's internal summarizer to extract a structured summary
3. Writes a handoff file (optional) — for compaction recovery
4. Posts to Discord (optional) — for team visibility
5. Pushes the summary to Locigram — for permanent memory storage

## Installation

```bash
# Clone the Locigram monorepo
git clone https://github.com/locigram/locigram
cd locigram

# Run the daemon (Bun required)
bun run packages/connectors/session-monitor/src/cli.ts start
```

## Configuration

Set environment variables before running:

```bash
# ── Required ─────────────────────────────────────────────────────────────────
LOCIGRAM_URL=http://localhost:3000          # Your Locigram server URL
LOCIGRAM_API_TOKEN=your-api-token          # Locigram palace API token

# ── Agent ─────────────────────────────────────────────────────────────────────
OPENCLAW_AGENT_NAME=main                   # Which agent to monitor (one daemon per agent)
OPENCLAW_AGENTS_DIR=~/.openclaw/agents     # Where OpenClaw stores agent session files

# ── Tuning ────────────────────────────────────────────────────────────────────
LOCIGRAM_SUMMARY_EVERY_N=5                 # Push a summary every N new messages (default: 5)
LOCIGRAM_COMPACTION_MB=8                   # Also push if session file exceeds this size in MB (default: 8)

# ── Handoff file (optional) ───────────────────────────────────────────────────
# Write a local markdown file with the latest session summary.
# Useful for compaction recovery — your agent reads this file on startup.
LOCIGRAM_HANDOFF_PATH=~/.openclaw/workspace/state/live-handoff.md
OPENCLAW_WORKSPACE_ROOT=~/.openclaw/workspace   # For archiving handoffs to memory/YYYY-MM-DD.md

# ── Discord (optional) ────────────────────────────────────────────────────────
# Post session summaries to a Discord channel.
# Omit DISCORD_BOT_TOKEN entirely to disable Discord integration.
DISCORD_BOT_TOKEN=your-discord-bot-token
SESSION_MONITOR_DISCORD_CHANNEL=your-channel-id

# ── Obsidian (optional) ───────────────────────────────────────────────────────
# Enable LLM-based project detection from your Obsidian vault.
OBSIDIAN_VAULT=~/your-obsidian-vault
```

## macOS LaunchAgent (auto-start)

```bash
# Install as a LaunchAgent (starts on login, restarts on crash)
bun run packages/connectors/session-monitor/src/cli.ts install

# Check status
bun run packages/connectors/session-monitor/src/cli.ts status

# Uninstall
bun run packages/connectors/session-monitor/src/cli.ts uninstall
```

## How it works

The daemon:
1. Scans `OPENCLAW_AGENTS_DIR/{OPENCLAW_AGENT_NAME}/sessions/` for `.jsonl` files
2. Picks the most recently active session (modified within 2 hours, largest wins)
3. Watches the file with a 2-second poll interval
4. On file growth, reads only the new bytes (incremental, never re-reads)
5. Every `LOCIGRAM_SUMMARY_EVERY_N` messages, triggers a summary + push cycle
6. Switches to a new session file automatically if the agent starts a new conversation

## What gets pushed to Locigram

Each push sends the LLM-generated summary (not the raw transcript) via `POST /api/sessions/ingest`. The summary is stored in your palace under `locus: agent/{OPENCLAW_AGENT_NAME}` and is retrievable via the `memory_session_start` MCP tool on the next session.

Raw transcript content is never stored — only the extracted summary.

## Multi-agent setup

Run one daemon instance per agent:

```bash
# Agent: main
OPENCLAW_AGENT_NAME=main LOCIGRAM_URL=... bun run src/cli.ts start

# Agent: devops
OPENCLAW_AGENT_NAME=devops LOCIGRAM_URL=... bun run src/cli.ts start
```

For macOS, install separate LaunchAgents per agent using the `install` command with different `OPENCLAW_AGENT_NAME` values.
