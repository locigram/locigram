# locigram-session-monitor — Integration Test Plan

## Prerequisites

- Locigram server running and accessible
- OpenClaw agent with at least one session file (`.jsonl`)
- Valid API token for the Locigram instance

## 1. Set environment variables

```bash
export LOCIGRAM_URL=http://localhost:3000
export LOCIGRAM_API_TOKEN=your-api-token
export OPENCLAW_AGENTS_DIR=~/.openclaw/agents
export OPENCLAW_AGENT_NAMES=main
export LOCIGRAM_PUSH_EVERY_N=5
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

Expected: prints watch info for each agent's newest `.jsonl` session file.

## 4. Generate session activity

In a separate terminal, interact with the OpenClaw agent (send a few messages).
The daemon watches `.jsonl` files for growth — each user/assistant message increments the counter.

## 5. Wait for push

After every 5 new messages (default `LOCIGRAM_PUSH_EVERY_N`), the daemon calls
`POST /api/sessions/ingest` with the rolling transcript buffer.

Watch daemon stdout for:
```
[session-monitor] pushed main/2026-03-03-<session> → {"stored":1,"skipped":0,"errors":[]}
```

## 6. Verify memories ingested

```bash
mcporter call locigram.memory_session_start \
  --args '{"locus":"agent/main","lookbackDays":1}'
```

Expected: `recentMemories` is non-empty and contains session transcript content.

## 7. Verify via REST API

```bash
curl -H "Authorization: Bearer $LOCIGRAM_API_TOKEN" \
  "$LOCIGRAM_URL/api/timeline?hours=1"
```

Expected: timeline includes locigrams with `sourceType: 'llm-session'` and
`connector: 'locigram-session-monitor'`.

## 8. Test install/uninstall (macOS)

```bash
node src/cli.ts install     # creates LaunchAgent plist + loads
node src/cli.ts status      # should show running
node src/cli.ts uninstall   # removes plist + unloads
```

## 9. Test install/uninstall (Linux)

```bash
node src/cli.ts install     # creates systemd user unit + enables + starts
systemctl --user status locigram-session-monitor
node src/cli.ts uninstall   # stops + disables + removes unit file
```

## 10. Edge cases

- **No session files**: start with empty agents dir — daemon should log "no session files found" and keep running.
- **New session file**: start a new OpenClaw session while daemon is running — daemon should detect and switch within 30s.
- **Server unreachable**: stop Locigram server — daemon should log push errors but not crash.
- **Large transcript**: send many messages — buffer should stay within `LOCIGRAM_MAX_TRANSCRIPT_CHARS` (tail truncation).
