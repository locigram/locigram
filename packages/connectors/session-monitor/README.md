# @locigram/session-monitor

A daemon that watches [OpenClaw](https://openclaw.ai) agent session files and pushes structured memory snapshots to your [Locigram](https://locigram.ai) palace.

Every N messages, it:
1. Reads the active session transcript
2. Calls Locigram's internal summarizer to extract a structured summary
3. Writes a handoff file (optional) — narrative markdown for compaction recovery
4. Writes `active-context.json` — structured JSON state alongside the handoff
5. Posts to Discord (optional) — for team visibility
6. Pushes the summary to Locigram — for permanent memory storage

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

# ── Active context (optional) ────────────────────────────────────────────────
# Write structured JSON state alongside the handoff. Defaults to same directory as LOCIGRAM_HANDOFF_PATH.
ACTIVE_CONTEXT_PATH=~/.openclaw/workspace/state/active-context.json

# ── Discord (optional) ────────────────────────────────────────────────────────
# Post session summaries to a Discord channel via incoming webhook.
# Create a webhook in Discord: channel settings → Integrations → Webhooks
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

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

## Outputs

### live-handoff.md (narrative)

Freeform markdown summary of the session — current task, decisions, files changed, next steps. Written to `LOCIGRAM_HANDOFF_PATH`.

### active-context.json (structured)

Auto-generated alongside each handoff dump. Contains machine-readable state:

```json
{
  "currentTask": "Implementing session-monitor improvements",
  "currentProject": "locigram",
  "pendingActions": ["Update README", "Run tests"],
  "recentDecisions": ["Use single LLM call for both outputs"],
  "blockers": [],
  "activeAgents": ["main"],
  "domain": "coding",
  "_autoUpdated": "2026-03-04T12:00:00.000Z",
  "_sessionId": "abc123",
  "_finalSnapshot": false
}
```

On daemon shutdown (SIGTERM/SIGINT), a final snapshot is written with `_finalSnapshot: true`.

## Features

### Task-aware summarization

The summarize prompt detects the primary domain of the transcript (infrastructure, coding, email, business/finance, general) and includes domain context in both the narrative and structured output.

### Startup reconciliation

On daemon start, if both `handoffPath` and `activeContextPath` files exist, the daemon cross-checks the `currentTask` from the JSON against the narrative handoff text. If they've diverged, it logs:

```
[session-monitor] context drift detected: JSON says "<task>" but narrative differs
```

### Pending action drift detection

Tracks `pendingActions` across handoff cycles. If the same action appears unchanged in 3+ consecutive handoffs, it logs:

```
[session-monitor] stale pending action: "<action>" unchanged for N handoffs
```

### Session continuity

If a new session file is detected within 15 minutes of the previous one, the daemon preserves context instead of archiving and resetting:

```
[session-monitor] session continuity: resuming within 15min window, preserving context
```

### Multi-agent awareness

On startup, logs how many agent session directories are found in the agents dir. Groundwork for future multi-agent coordination.

### End-of-session final snapshot

On SIGTERM/SIGINT, the daemon writes a final `active-context.json` with `_finalSnapshot: true` alongside the final handoff dump.

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

## Future: Locigram as query layer

The `locigram-context.ts` module provides a `fetchActiveContextFromLocigram()` function that will query the Locigram server directly via `GET /api/context/active?locus=agent/{agentName}`. Falls back to disk read if the server is unavailable. This enables agents to query Locigram for active context without relying solely on the local JSON file.
