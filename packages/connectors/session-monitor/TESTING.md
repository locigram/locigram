# locigram-session-monitor — Integration Test Plan

## Prerequisites

- Locigram server running and accessible
- OpenClaw agent with at least one session file (`.jsonl`)
- Valid API token for the Locigram instance

## 1. Set environment variables

```bash
# Required
export LOCIGRAM_URL=http://localhost:3000
export LOCIGRAM_API_TOKEN=your-api-token

# Agent (one daemon instance per agent)
export OPENCLAW_AGENT_NAME=main
export OPENCLAW_AGENTS_DIR=~/.openclaw/agents

# Optional — handoff file
export LOCIGRAM_HANDOFF_PATH=~/.openclaw/workspace/state/live-handoff.md
export OPENCLAW_WORKSPACE_ROOT=~/.openclaw/workspace

# Optional — Discord
# export DISCORD_BOT_TOKEN=your-bot-token
# export SESSION_MONITOR_DISCORD_CHANNEL=your-channel-id
```

## 2. Verify config and connectivity

```bash
node src/cli.ts status
```

Expected: prints config summary and `Locigram health check: 200`.

## 3. Start the daemon

```bash
node src/cli.ts start
```

Expected output:
```
[session-monitor][main] daemon started
[session-monitor][main] agent: main
[session-monitor][main] sessions dir: ~/.openclaw/agents/main/sessions
[session-monitor][main] summary every 5 messages
[session-monitor][main] compaction threshold: 8mb
[session-monitor][main] locigram: http://localhost:3000
```

## 4. Generate session activity

In a separate terminal, interact with the OpenClaw agent (send a few messages).
The daemon watches `.jsonl` files for growth — each user/assistant message increments the counter.

## 5. Handoff trigger (message count)

After every 5 new messages (default `LOCIGRAM_SUMMARY_EVERY_N`), the daemon:
1. Reads the raw JSONL session file (beginning + recent messages)
2. Calls `POST /api/internal/summarize` on the Locigram server for LLM summarization
3. Writes the summary to `LOCIGRAM_HANDOFF_PATH` (if set)
4. Posts to Discord (if `DISCORD_BOT_TOKEN` + `SESSION_MONITOR_DISCORD_CHANNEL` set)
5. Pushes the summary to `POST /api/sessions/ingest` on Locigram (always)

Watch daemon stdout for:
```
[session-monitor][main] handoff: using jsonl as source (12345 chars)
[session-monitor][main] handoff dump written (message-count): ~/.openclaw/workspace/state/live-handoff.md
[session-monitor][main] handoff pushed to Locigram
[session-monitor][main] locigram push: stored=1 skipped=0
```

## 6. Handoff trigger (file size)

When the session file exceeds `LOCIGRAM_COMPACTION_MB` (default 8mb), the same handoff
flow triggers automatically. A 10-minute cooldown prevents repeated dumps.

## 7. Session switching

When a new session file appears (e.g. after compaction), the daemon:
1. Archives the existing handoff to a timestamped file
2. Appends the handoff to `memory/YYYY-MM-DD.md` (if `OPENCLAW_WORKSPACE_ROOT` set)
3. Switches to watching the new file

## 8. Shutdown handoff

Send `SIGINT` or `SIGTERM` to the daemon — it performs a final handoff dump before exiting.

## 9. Verify memories ingested

```bash
curl -H "Authorization: Bearer $LOCIGRAM_API_TOKEN" \
  "$LOCIGRAM_URL/api/timeline?hours=1"
```

Expected: timeline includes locigrams with `sourceType: 'llm-session'` and
`connector: 'locigram-session-monitor'`.

## 10. Test install/uninstall (macOS)

```bash
node src/cli.ts install     # creates LaunchAgent plist + loads
node src/cli.ts status      # should show running
node src/cli.ts uninstall   # removes plist + unloads
```

## 11. Test install/uninstall (Linux)

```bash
node src/cli.ts install     # creates systemd user unit + enables + starts
systemctl --user status locigram-session-monitor
node src/cli.ts uninstall   # stops + disables + removes unit file
```

## 12. Edge cases

- **No session files**: start with empty agents dir — daemon should log "unable to read sessions dir" and keep running.
- **New session file**: start a new OpenClaw session while daemon is running — daemon should detect and switch within 30s.
- **Server unreachable**: stop Locigram server — daemon should log push errors but not crash.
- **LLM unavailable**: `/api/internal/summarize` returns error — daemon falls back to raw transcript tail.
- **Multi-agent**: run separate daemon instances with different `OPENCLAW_AGENT_NAME` values; install creates one LaunchAgent per invocation.
- **Large session file**: session exceeds compaction threshold — triggers size-based handoff with cooldown.
