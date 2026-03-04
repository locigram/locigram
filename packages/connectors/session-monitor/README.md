# @locigram/session-monitor

A daemon that watches [OpenClaw](https://openclaw.ai) agent session files and pushes structured memory snapshots to your [Locigram](https://locigram.ai) palace.

Every N messages, it:
1. Reads the active session transcript (incremental — never re-reads)
2. Calls Locigram's `/api/internal/summarize` to extract a structured summary
3. Writes `live-handoff.md` (optional) — narrative markdown for compaction recovery
4. Writes `active-context.json` — structured JSON state (auto-maintained, never edit manually)
5. Posts to Discord (optional) — for team visibility
6. Pushes the summary to Locigram under hierarchical loci

## Installation

```bash
# Clone the Locigram monorepo
git clone https://github.com/locigram/locigram
cd locigram

# Run the daemon (Bun required)
bun run packages/connectors/session-monitor/src/cli.ts start
```

## Subcommands

| Command | Description |
|---------|-------------|
| `start` | Run the daemon (blocking). Validates config, watches session files, pushes summaries on interval. |
| `complete` | One-shot completion summary for ephemeral agents. Finds newest session, summarizes, pushes, exits. |
| `install` | Install as a per-agent system service (macOS LaunchAgent or Linux systemd user unit). |
| `uninstall` | Remove the system service for this agent. |
| `status` | Print current config, check Locigram server connectivity via `/api/health`. |

```bash
locigram-session-monitor start       # Run daemon (blocking)
locigram-session-monitor complete    # One-shot completion summary (ephemeral agents)
locigram-session-monitor install     # Install as system service (launchd/systemd)
locigram-session-monitor uninstall   # Remove system service
locigram-session-monitor status      # Check config and connectivity
```

## Environment Variables

### Required

| Variable | Description | Default |
|----------|-------------|---------|
| `LOCIGRAM_URL` | Locigram server URL | _(required)_ |
| `LOCIGRAM_API_TOKEN` | Locigram palace API token | _(required)_ |

### Agent Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_AGENT_NAME` | Agent name (one daemon per agent). Also accepts `AGENT_NAME`. | `main` |
| `LOCIGRAM_AGENT_TYPE` | Agent type: `permanent` or `ephemeral` | `permanent` |
| `OPENCLAW_AGENTS_DIR` | Path to OpenClaw agents directory | `~/.openclaw/agents` |

### Tuning

| Variable | Description | Default |
|----------|-------------|---------|
| `LOCIGRAM_SUMMARY_EVERY_N` | Trigger handoff every N new messages | `5` |
| `LOCIGRAM_COMPACTION_MB` | Also trigger handoff if session file exceeds this size (MB) | `8` |

Internal (not configurable via env):
- Watch interval: 2 seconds (file poll)
- Session scan interval: 30 seconds (discover new session files)
- Dump cooldown: 10 minutes (minimum between size-triggered handoffs)
- Project detection interval: 5 minutes (when Obsidian vault configured)
- Heartbeat interval: 10 minutes

### Optional — Handoff File

| Variable | Description | Default |
|----------|-------------|---------|
| `LOCIGRAM_HANDOFF_PATH` | Write handoff summary to this file | _(not set)_ |
| `ACTIVE_CONTEXT_PATH` | Write `active-context.json` here | Same directory as `LOCIGRAM_HANDOFF_PATH` |
| `OPENCLAW_WORKSPACE_ROOT` | Workspace root for archiving handoffs to `memory/YYYY-MM-DD.md` | _(not set)_ |

### Optional — Integrations

| Variable | Description | Default |
|----------|-------------|---------|
| `OBSIDIAN_VAULT` | Obsidian vault path for LLM-based project detection | _(not set)_ |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for posting summaries | _(not set)_ |

## Agent Types

### Permanent agents (`LOCIGRAM_AGENT_TYPE=permanent`, default)

Full daemon behavior. The session monitor runs continuously:
- Watches session files with 2-second polling
- Pushes summaries every N messages and on file size threshold
- Pushes structured context to `agent/{name}/context` (appears in fleet status)
- Sends heartbeats to `agent/{name}/heartbeat` every 10 minutes
- Performs startup reconciliation and drift detection
- Writes final snapshot on SIGTERM/SIGINT

```bash
LOCIGRAM_AGENT_TYPE=permanent  # or omit — permanent is the default
locigram-session-monitor start
```

### Ephemeral agents (`LOCIGRAM_AGENT_TYPE=ephemeral`)

Spawned for a specific task, complete and exit. Use the `complete` subcommand at the end of a task to push a one-shot completion summary.

Ephemeral agents push to `agent/{name}/session/{sessionId}` only — they do **not** push to `agent/{name}/context` and therefore do **not** appear in fleet status.

```bash
export LOCIGRAM_AGENT_TYPE=ephemeral
export OPENCLAW_AGENT_NAME=task-runner-42

# ... agent does its work ...

locigram-session-monitor complete   # generates + pushes summary, then exits
```

The `complete` subcommand:
1. Finds the most recent session JSONL for the agent
2. Reads the transcript (first 10 + last 140 messages, each truncated to 600 chars)
3. Calls `/api/internal/summarize` with a completion-focused prompt
4. Pushes the summary to Locigram under `agent/{agentName}/session/{sessionId}`
5. Writes a `completion-report.md` to `LOCIGRAM_HANDOFF_PATH` directory if configured
6. Exits cleanly

## Locus Hierarchy

The session monitor uses a hierarchical locus scheme to organize agent data in Locigram:

| Locus pattern | Written by | Description |
|---|---|---|
| `agent/{name}/session/{sessionId}` | Both permanent and ephemeral | Individual session summaries (every handoff cycle / on complete) |
| `agent/{name}/context` | Permanent only | Current active context — structured JSON state. Powers fleet status. |
| `agent/{name}/heartbeat` | Permanent only | Liveness signals (every 10 min) |

Legacy flat loci (e.g. `agent/main`) are still supported — the server maps them to `agent/{name}/context` automatically.

## active-context.json Schema

Auto-generated alongside each handoff dump. This file is auto-maintained — never edit manually.

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

| Field | Type | Description |
|-------|------|-------------|
| `currentTask` | `string` | What the agent is working on right now |
| `currentProject` | `string` | Project/repo name |
| `pendingActions` | `string[]` | Outstanding items to complete |
| `recentDecisions` | `string[]` | Key decisions made this session |
| `blockers` | `string[]` | Anything blocking progress |
| `activeAgents` | `string[]` | Other agents detected in the agents dir |
| `domain` | `string` | Detected domain: `infrastructure`, `coding`, `email`, `business/finance`, `general` |
| `_autoUpdated` | `string` | ISO timestamp of last update |
| `_sessionId` | `string` | Session file name (without `.jsonl`) |
| `_finalSnapshot` | `boolean?` | `true` on daemon shutdown (SIGTERM/SIGINT). Absent or `false` otherwise. |

## Multi-Instance Install

Each agent gets its own named system service. Multiple agents run simultaneously without conflict.

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
- **LaunchAgent label:** `com.locigram.session-monitor.{agentName}`
- **Plist file:** `~/Library/LaunchAgents/com.locigram.session-monitor.{agentName}.plist`
- **Stdout log:** `/tmp/locigram-session-monitor-{agentName}.log`
- **Stderr log:** `/tmp/locigram-session-monitor-{agentName}.error.log`
- Auto-starts on login, restarts on crash
- Loaded/unloaded via `launchctl bootstrap`/`bootout`

### Linux (systemd user units)

```bash
# Install for agent "main"
OPENCLAW_AGENT_NAME=main LOCIGRAM_URL=... LOCIGRAM_API_TOKEN=... \
  locigram-session-monitor install

# Install for agent "devops"
OPENCLAW_AGENT_NAME=devops LOCIGRAM_URL=... LOCIGRAM_API_TOKEN=... \
  locigram-session-monitor install
```

Each agent gets:
- **Unit file:** `~/.config/systemd/user/locigram-session-monitor-{agentName}.service`
- Managed via `systemctl --user {start|stop|status|restart} locigram-session-monitor-{agentName}.service`
- Auto-restarts on failure

### Uninstall a specific agent

```bash
OPENCLAW_AGENT_NAME=devops locigram-session-monitor uninstall
```

## Features

### Domain Detection

The summarization prompt detects the primary domain of the transcript:
- `infrastructure` — server setup, networking, deployment, Docker, K8s, CI/CD
- `coding` — writing/debugging code, implementing features, refactoring
- `email` — email management, correspondence, communication
- `business/finance` — invoicing, contracts, client management, accounting
- `general` — everything else

The domain is included in both the narrative handoff and structured `active-context.json`.

### Startup Reconciliation

On daemon start, if both `LOCIGRAM_HANDOFF_PATH` and `ACTIVE_CONTEXT_PATH` files exist, the daemon cross-checks the `currentTask` from the JSON against the narrative handoff text. If they've diverged, it logs:

```
[session-monitor] context drift detected: JSON says "<task>" but narrative differs
```

### Pending Action Drift Detection

Tracks `pendingActions` across handoff cycles. If the same action appears unchanged in 3+ consecutive handoffs, it logs:

```
[session-monitor] stale pending action: "<action>" unchanged for N handoffs
```

### Session Continuity

If a new session file is detected within 15 minutes of the previous one, the daemon preserves context instead of archiving and resetting:

```
[session-monitor] session continuity: resuming within 15min window, preserving context
```

Outside the 15-minute window, the previous handoff is archived (timestamped copy + append to `memory/YYYY-MM-DD.md` if `OPENCLAW_WORKSPACE_ROOT` is set).

### Heartbeat

Permanent agents send a heartbeat to `POST /api/agents/{agentName}/heartbeat` every 10 minutes. The heartbeat includes `agentType` and `status: "alive"`. If no heartbeat is received in 30 minutes, the agent should be considered potentially stale.

### End-of-Session Final Snapshot

On SIGTERM/SIGINT, the daemon:
1. Triggers a final handoff dump (trigger reason: `shutdown`)
2. Writes `active-context.json` with `_finalSnapshot: true`
3. Exits cleanly

### Multi-Agent Awareness

On startup, logs how many agent session directories are found in the agents dir:

```
[session-monitor] multi-agent: 3 agent session dir(s) found in ~/.openclaw/agents
```

## Heartbeat & Fleet Status

### Heartbeat endpoint

```
POST /api/agents/{agentName}/heartbeat
```

Stores a lightweight locigram under `agent/{agentName}/heartbeat`.

### Fleet status endpoint

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3000/api/context/fleet
```

Returns all agents that have pushed context (permanent agents only — queries `agent/*/context` loci):

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

## Programmatic Query Layer (`locigram-context.ts`)

The `locigram-context.ts` module exports functions for querying Locigram from other code:

### `fetchActiveContextFromLocigram(config)`

Fetches the current agent's active context. Queries `GET /api/context/active?locus=agent/{agentName}/context`. Falls back to reading `ACTIVE_CONTEXT_PATH` from disk if the server is unavailable.

Returns `ActiveContext | null`.

### `fetchFleetStatus(config)`

Fetches all agents' current state. Calls `GET /api/context/fleet`. Returns `AgentState[]` — permanent agents only (those that have pushed to `agent/{name}/context`).

### `fetchAgentContext(config, agentName)`

Fetches a specific agent's active context by name. Calls `GET /api/context/active?locus=agent/{agentName}/context`. Returns `ActiveContext | null`.

### Types

```typescript
interface ActiveContext {
  currentTask: string
  currentProject: string
  pendingActions: string[]
  recentDecisions: string[]
  blockers: string[]
  activeAgents: string[]
  domain: string
  _autoUpdated: string
  _sessionId: string
  _finalSnapshot?: boolean
}

interface AgentState {
  agentName: string
  currentTask: string | null
  currentProject: string | null
  blockers: string[]
  domain: string | null
  lastSeen: string
  agentType: string
}
```

## How It Works

1. Scans `OPENCLAW_AGENTS_DIR/{OPENCLAW_AGENT_NAME}/sessions/` for `.jsonl` files
2. Picks the most recently active session (modified within 2 hours, largest wins)
3. Watches the file with a 2-second poll interval
4. On file growth, reads only the new bytes (incremental, never re-reads)
5. Every `LOCIGRAM_SUMMARY_EVERY_N` messages, triggers a summary + push cycle
6. Pushes session summaries to `agent/{name}/session/{sessionId}` and active context to `agent/{name}/context`
7. Sends heartbeat to `agent/{name}/heartbeat` every 10 minutes
8. Rescans for new session files every 30 seconds; switches automatically
9. On shutdown (SIGTERM/SIGINT), writes final handoff + final snapshot

## What Gets Pushed to Locigram

Each push sends the LLM-generated summary (not the raw transcript) via `POST /api/sessions/ingest`. Summaries are stored under hierarchical loci:

- **Session summaries** → `agent/{agentName}/session/{sessionId}` (every handoff cycle)
- **Active context** → `agent/{agentName}/context` (structured JSON, permanent agents only)
- **Heartbeats** → `agent/{agentName}/heartbeat` (every 10 minutes, permanent agents only)

Raw transcript content is never stored — only the extracted summary.
