# obsidian-audit — Build Spec

## Purpose
Weekly LaunchAgent that scans the Obsidian vault, checks what's already
covered in Locigram, and uses an LLM to evaluate each note for indexing
worthiness. Outputs an approved index list that obsidian-sync consumes.

## Runtime
- **Platform:** m4pro-01 (macOS, NOT K3s — vault is local)
- **Schedule:** Weekly, Sunday 2am via LaunchAgent
- **Package:** `@locigram/connector-obsidian-audit`
- **Install:** LaunchAgent `com.locigram.obsidian-audit`
- **Language:** TypeScript, Bun runtime

## Vault
- Path: `/Users/surubot/sudobrain/` (env var `OBSIDIAN_VAULT`)
- File glob: `**/*.md`
- Total: ~918 notes

## Config Output
- Path: `~/.locigram/obsidian-index.json` (env var `INDEX_PATH`, default `~/.locigram/obsidian-index.json`)
- Format:
```json
{
  "generated": "ISO timestamp",
  "version": 1,
  "entries": [
    {
      "path": "Infrastructure/MCP-Servers.md",
      "verdict": "index",
      "reason": "Critical infrastructure reference, not in Locigram",
      "locus": "notes/infrastructure",
      "lastAudited": "ISO timestamp",
      "mtime": "ISO timestamp"
    }
  ]
}
```
- Verdicts: `"index"` | `"skip"` | `"covered"`
- On re-run: preserve existing entries, only re-evaluate new/changed files
  (changed = mtime newer than lastAudited)

## Locigram State Check
Query Locigram to understand what's already covered:
- URL: env var `LOCIGRAM_MCP_URL` (default `http://locigram-server.locigram-main:3000/mcp`)
  BUT on m4pro-01 use `http://10.10.100.82:30310/mcp` as default
- Bearer: env var `LOCIGRAM_TOKEN`
- Call `memory_session_start` (locus="agent/main", lookbackDays=30) to get coverage summary
- Use this as context when evaluating notes — don't re-index what's clearly already there

## LLM Evaluation
- URL: env var `LLM_URL` (default `http://10.10.100.80:30891/v1`)
- Model: env var `LLM_MODEL` (default `qwen3.5-35b-a3b`)
- Batch notes into groups of 10 for efficiency
- For each note, send: file path + first 500 chars of content
- System prompt: evaluate whether this note contains durable knowledge
  worth retrieving in future AI sessions (architecture decisions,
  infrastructure docs, business context, project status, research).
  Skip: agent build logs, one-off session artifacts, empty/stub notes,
  template pages, notes with junk filenames (>50 chars or all lowercase words run together).
- Response format per note: `{ "verdict": "index"|"skip"|"covered", "locus": "notes/...", "reason": "..." }`
- If LLM unreachable: default all new notes to `"skip"` with reason "LLM unavailable" — do NOT crash

## Locus Assignment (LLM decides, but guide it)
- `Decisions/` → `notes/decisions`
- `Infrastructure/` → `notes/infrastructure`
- `Brain/` → `notes/observations`
- `Business/` → `notes/observations`
- `Projects/` → `notes/observations`
- `Research/` → `notes/observations`
- `People/` → `notes/people`

## Skip Rules (pre-filter before LLM — save tokens)
Always skip without calling LLM:
- Filename > 60 chars (agent session artifacts)
- Filename contains UUID pattern
- File size < 100 bytes (empty/stub)
- Path contains `archive/` or `retired/`
- Content starts with `# Current State\n- Newly detected` (session-monitor stubs)

## File Structure
```
packages/connectors/obsidian-audit/
├── src/
│   ├── index.ts        # main: scan vault, load existing index, evaluate new/changed
│   ├── vault.ts        # scan vault files, read content, check mtime
│   ├── llm.ts          # batch LLM evaluation
│   ├── locigram.ts     # check Locigram coverage (memory_session_start)
│   └── index-store.ts  # read/write ~/.locigram/obsidian-index.json
├── launchagent/
│   └── com.locigram.obsidian-audit.plist  # weekly Sunday 2am
├── package.json
├── tsconfig.json
└── SPEC.md
```

## LaunchAgent plist
- Label: `com.locigram.obsidian-audit`
- Program: `/opt/homebrew/opt/node@22/bin/node` (or bun)
- Args: path to compiled index.ts
- Schedule: `StartCalendarInterval` — weekday 0 (Sunday), hour 2, minute 0
- Env vars: OBSIDIAN_VAULT, LOCIGRAM_MCP_URL, LOCIGRAM_TOKEN, LLM_URL, LLM_MODEL, INDEX_PATH
- Log: `/tmp/com.locigram.obsidian-audit.log`
- KeepAlive: false (run once, exit)

## package.json
```json
{
  "name": "@locigram/connector-obsidian-audit",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun run --watch src/index.ts"
  },
  "dependencies": {}
}
```
No external deps needed — Bun has fs and fetch built in.
