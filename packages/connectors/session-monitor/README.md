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
LOCIGRAM_AGENT_TYPE=permanent              # Agent type: permanent | ephemeral (default: permanent)
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

## Agent Types

### Permanent agents (default)

Full daemon behavior. The session monitor runs continuously, watching session files, pushing summaries every N messages, and sending heartbeats every 10 minutes.

```bash
LOCIGRAM_AGENT_TYPE=permanent  # or omit — permanent is the default
locigram-session-monitor start
```

### Ephemeral agents

Spawned for a specific task, complete and exit. Use the `complete` subcommand at the end of a task to push a one-shot completion summary.

```bash
LOCIGRAM_AGENT_TYPE=ephemeral
# ... agent does its work ...
locigram-session-monitor complete   # generates + pushes summary, then exits
```

The `complete` subcommand:
1. Finds the most recent session JSONL for the agent
2. Reads the transcript and calls `/api/internal/summarize` for a one-shot summary
3. Pushes the summary to Locigram under `agent/{agentName}/session/{sessionId}`
4. Writes a `completion-report.md` to `LOCIGRAM_HANDOFF_PATH` if set
5. Exits cleanly

## Locus Hierarchy

The session monitor uses a hierarchical locus scheme to organize agent data in Locigram:

| Locus pattern | Description |
|---|---|
| `agent/{name}/session/{sessionId}` | Individual session transcripts/summaries |
| `agent/{name}/context` | Current active context (latest structured state) |
| `agent/{name}/heartbeat` | Liveness signals |

Legacy flat loci (e.g. `agent/main`) are still supported — the server maps them to `agent/{name}/context` automatically.

## Multi-Instance Setup

Each agent gets its own named system service. Multiple agents can run simultaneously without overwriting each other.

### macOS (LaunchAgents)

```bash
# Install for agent "main"
OPENCLAW_AGENT_NAME=main LOCIGRAM_URL=... LOCIGRAM_API_TOKEN=... \
  locigram-session-monitor install

# Install for agent "devops" (separate plist, separate logs)
OPENCLAW_AGENT_NAME=devops LOCIGRAM_URL=... LOCIGRAM_API_TOKEN=... \
  locigram-session-monitor install
```

Each agent gets:
- LaunchAgent label: `com.locigram.session-monitor.{agentName}`
- Plist file: `~/Library/LaunchAgents/com.locigram.session-monitor.{agentName}.plist`
- Logs: `/tmp/locigram-session-monitor-{agentName}.log` and `.error.log`

### Linux (systemd)

```bash
# Install for agent "main"
OPENCLAW_AGENT_NAME=main LOCIGRAM_URL=... LOCIGRAM_API_TOKEN=... \
  locigram-session-monitor install

# Install for agent "devops"
OPENCLAW_AGENT_NAME=devops LOCIGRAM_URL=... LOCIGRAM_API_TOKEN=... \
  locigram-session-monitor install
```

Each agent gets:
- Unit file: `~/.config/systemd/user/locigram-session-monitor-{agentName}.service`
- Managed independently via `systemctl --user {start|stop|status} locigram-session-monitor-{agentName}.service`

### Uninstall a specific agent

```bash
OPENCLAW_AGENT_NAME=devops locigram-session-monitor uninstall
```

## Heartbeat

Permanent agents send a heartbeat to `POST /api/agents/{agentName}/heartbeat` every 10 minutes, even when no new messages are being processed. This allows the fleet status endpoint to detect stale agents.

If no heartbeat is received in 30 minutes, the agent should be considered potentially stale.

The heartbeat includes:
- `agentType`: "permanent" or "ephemeral"
- `status`: "alive"

## Fleet Status

Query `GET /api/context/fleet` to see all agents that have pushed context:

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3000/api/context/fleet
```

Returns:
```json
[
  {
    "agentName": "main",
    "currentTask": "Implementing multi-agent architecture",
    "currentProject": "locigram",
    "blockers": [],
    "domain": "coding",
    "lastSeen": "2026-03-04T12:00:00.000Z",
    "agentType": "permanent"
  }
]
```

The session monitor's `locigram-context.ts` module exposes:
- `fetchFleetStatus(config)` — calls `GET /api/context/fleet`
- `fetchAgentContext(config, agentName)` — calls `GET /api/context/active?locus=agent/{agentName}/context`

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
6. Pushes session summaries to `agent/{name}/session/{sessionId}` and active context to `agent/{name}/context`
7. Sends heartbeat to `agent/{name}/heartbeat` every 10 minutes
8. Switches to a new session file automatically if the agent starts a new conversation

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

Each push sends the LLM-generated summary (not the raw transcript) via `POST /api/sessions/ingest`. Summaries are stored under hierarchical loci:

- **Session summaries** → `agent/{agentName}/session/{sessionId}` (every handoff cycle)
- **Active context** → `agent/{agentName}/context` (structured JSON, every handoff cycle)
- **Heartbeats** → `agent/{agentName}/heartbeat` (every 10 minutes)

Raw transcript content is never stored — only the extracted summary.

## Future: Locigram as query layer

The `locigram-context.ts` module provides:

- `fetchActiveContextFromLocigram(config)` — queries `GET /api/context/active?locus=agent/{agentName}/context`, falls back to disk
- `fetchFleetStatus(config)` — queries `GET /api/context/fleet`, returns all agent states
- `fetchAgentContext(config, agentName)` — queries a specific agent's context
