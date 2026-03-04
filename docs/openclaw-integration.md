# Locigram × OpenClaw Integration Guide

> How to wire up `locigram-session-monitor` to an OpenClaw agent workspace.
> Covers install, required env vars, and the exact changes needed in SOUL.md, AGENTS.md, and memory config.

---

## What the Session Monitor Does

Every 5 messages (or 8MB), it:
1. Reads the agent's active JSONL session file
2. Calls `/api/internal/summarize` → gets narrative + structured JSON
3. Writes `state/live-handoff.md` (narrative summary)
4. Writes `state/active-context.json` (structured JSON — **never manually maintain this**)
5. Pushes to Locigram under `agent/{name}/session/{sessionId}` and `agent/{name}/context`
6. Posts to Discord webhook
7. Sends heartbeat to `agent/{name}/heartbeat` every 10min

---

## Step 1: Install the Session Monitor

### Required env vars

| Var | Value | Purpose |
|-----|-------|---------|
| `LOCIGRAM_URL` | `http://10.10.100.82:30310` | Locigram server |
| `LOCIGRAM_API_TOKEN` | `e572d1f4292c724e7b896cf3a73acfd16efdfb045643c0fac798c8ce5a7c08a1` | Auth |
| `OPENCLAW_AGENT_NAME` | `main` (or agent name) | Which agent this monitors |
| `LOCIGRAM_HANDOFF_PATH` | `/path/to/workspace/state/live-handoff.md` | Where to write narrative handoff |
| `OPENCLAW_WORKSPACE_ROOT` | `/path/to/workspace` | Workspace root (enables memory archival) |
| `OPENCLAW_AGENTS_DIR` | `~/.openclaw/agents` | Where agent JSONL sessions live |

### Optional env vars

| Var | Value | Purpose |
|-----|-------|---------|
| `ACTIVE_CONTEXT_PATH` | (auto-derived) | Defaults to `dirname(HANDOFF_PATH)/active-context.json` |
| `OBSIDIAN_VAULT` | `/path/to/vault` | Enables project detection (requires WORKSPACE_ROOT) |
| `DISCORD_WEBHOOK_URL` | webhook URL | Posts handoff summaries to Discord |
| `LOCIGRAM_SUMMARY_EVERY_N` | `5` | How many messages between handoffs |
| `LOCIGRAM_COMPACTION_MB` | `8` | Also trigger handoff at this file size |
| `LOCIGRAM_AGENT_TYPE` | `permanent` | `permanent` = fleet-visible; `ephemeral` = session-only |

### Install command (macOS)

```bash
LOCIGRAM_URL=http://10.10.100.82:30310 \
LOCIGRAM_API_TOKEN=e572d1f4292c724e7b896cf3a73acfd16efdfb045643c0fac798c8ce5a7c08a1 \
OPENCLAW_AGENT_NAME=main \
LOCIGRAM_HANDOFF_PATH=/Users/surubot/.openclaw/workspace/state/live-handoff.md \
OPENCLAW_WORKSPACE_ROOT=/Users/surubot/.openclaw/workspace \
OPENCLAW_AGENTS_DIR=/Users/surubot/.openclaw/agents \
OBSIDIAN_VAULT=/Users/surubot/sudobrain \
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... \
  bun run /Users/surubot/locigram/packages/connectors/session-monitor/src/cli.ts install
```

This creates `~/Library/LaunchAgents/com.locigram.session-monitor.main.plist` and loads it immediately.

### Current install on m4pro-01

The `main` agent plist is at `~/Library/LaunchAgents/com.locigram.session-monitor.plist` (label: `com.locigram.session-monitor`, not per-agent suffix because it was installed before the multi-agent naming was added). All env vars confirmed correct. Logs: `/tmp/locigram-session-monitor.log`.

---

## Step 2: AGENTS.md Changes Required

The current AGENTS.md memory write table is **split across two systems** (suruDB memory API + Locigram). This needs to be consolidated to Locigram only.

### Current (broken) state

```
| New fact or observation | Memory API | POST /api/memory/observations |
| Lesson learned          | Memory API | POST /api/memory/lessons      |
| Decision made           | Locigram   | mcporter call locigram.memory_remember |
```

### What it should be (all Locigram)

| What happened | Locigram locus | How |
|---|---|---|
| New fact or observation | `notes/observations` | `mcporter call locigram.memory_remember --args '{"content":"...","locus":"notes/observations","sourceType":"manual"}'` |
| Lesson learned | `notes/lessons` | `mcporter call locigram.memory_remember --args '{"content":"...","locus":"notes/lessons","sourceType":"manual"}'` |
| Architecture/design decision | `notes/decisions` | `mcporter call locigram.memory_remember --args '{"content":"...","locus":"notes/decisions","sourceType":"agent-decision"}'` |
| Infrastructure change | `notes/infrastructure` | `mcporter call locigram.memory_remember --args '{"content":"...","locus":"notes/infrastructure","sourceType":"agent-decision"}'` |
| Project milestone | `notes/projects` | `mcporter call locigram.memory_remember --args '{"content":"...","locus":"notes/projects","sourceType":"agent-decision"}'` |
| Person or client info | `notes/people` | `mcporter call locigram.memory_remember --args '{"content":"...","locus":"notes/people","sourceType":"manual"}'` |

**Remove from AGENTS.md:**
- All references to `POST /api/memory/observations`
- All references to `POST /api/memory/lessons`
- The `Bearer suruos-local-2026` auth line (wrong token anyway — correct is `c4f48ac502074aaa2178cce05318664d3727695c8d739b64`)
- The note about "Observations and lessons go to the API so they're searchable via Qdrant" — Locigram has its own Qdrant

**Keep in AGENTS.md:**
- Obsidian writes via obsidian-cli (for human-readable structured docs — Locigram is agent memory, Obsidian is project docs)
- MEMORY.md as index/table-of-contents
- memory/YYYY-MM-DD.md flush files

### Also update the reading section

Current reading order sends agents to the suruDB Qdrant (`POST localhost:3200/api/memory/search`). Should be:
1. Check MEMORY.md for pointer
2. `mcporter call locigram.memory_session_start --args '{"locus":"agent/main","lookbackDays":7}'`
3. `Read()` the pointed Obsidian file
4. `grep -r "topic" /Users/surubot/sudobrain/` as last resort

---

## Step 3: SOUL.md Changes Required

The post-compaction section in SOUL.md is already mostly correct:

```bash
mcporter call locigram.memory_session_start --args '{"locus":"agent/main","lookbackDays":7}'
```

**What's correct:** Locigram session_start as the primary recovery call. ✅

**What to fix:** The fallback order should be:
1. Locigram `memory_session_start` (primary)
2. `state/live-handoff.md` (written by session monitor — always current)
3. `state/active-context.json` (written by session monitor — structured)
4. `memory/YYYY-MM-DD.md` (pre-compaction flush)
5. MEMORY.md (index)

The current fallback says "Read live-handoff.md → memory/YYYY-MM-DD.md → MEMORY.md → active-context.json" — active-context.json should come before the date file since it's more structured and current.

---

## Step 4: active-context.json — Stop Manually Maintaining It

**Current problem:** AGENTS.md DIRECTIVE #1 says `state/active-context.json` must be committed as memory. The session monitor now owns this file — it overwrites it every 5 messages.

**Fix:** Remove `state/active-context.json` from the memory commit directive. It's not a file agents should write — only read. The session monitor writes it; agents read it for context recovery.

---

## Step 5: The Correct Memory Architecture (Post-Migration)

```
WRITE PATHS:
  Agent decisions/facts/lessons  →  mcporter call locigram.memory_remember
  Session transcripts + context  →  session monitor (automatic, no agent action needed)
  Human-readable project docs    →  obsidian-cli → sudobrain vault
  Daily flush (pre-compaction)   →  memory/YYYY-MM-DD.md (flat file, stays)
  MEMORY.md index                →  manual update (stays, but shrinks over time)

READ PATHS:
  Post-compaction recovery       →  Locigram memory_session_start (primary)
  Live task context              →  state/live-handoff.md + state/active-context.json
  Project detail                 →  Obsidian vault files
  Historical index               →  MEMORY.md

DEPRECATED (suruDB memory schema):
  POST /api/memory/observations  →  migrate to Locigram notes/observations
  POST /api/memory/lessons       →  migrate to Locigram notes/lessons
  POST /api/memory/decisions     →  (was never heavily used by agents)
  9,421 existing records         →  one-time migration script needed
```

---

## Migration TODO

- [ ] Update AGENTS.md write table (all writes → Locigram, remove Memory API references)
- [ ] Update SOUL.md fallback order (active-context.json before memory/YYYY-MM-DD.md)
- [ ] Remove active-context.json from AGENTS.md DIRECTIVE #1 memory commit list
- [ ] Write migration script: suruDB `memory.observations` + `memory.lessons` → Locigram with locus `notes/observations` and `notes/lessons`
- [ ] Fix wrong auth token in AGENTS.md (`suruos-local-2026` → `c4f48ac502074aaa2178cce05318664d3727695c8d739b64`)
- [ ] After migration: disable write endpoints on local-api `/api/memory/observations` and `/api/memory/lessons`
