# obsidian-sync — Build Spec

## Purpose
Nightly LaunchAgent that reads the approved index from obsidian-audit,
checks which notes have changed since last sync, summarizes them via LLM,
and upserts to Locigram. Each memory includes the Obsidian deep link so
any AI can point users to the full note.

## Runtime
- **Platform:** m4pro-01 (macOS, NOT K3s — vault is local)
- **Schedule:** Nightly 4am via LaunchAgent
- **Package:** `@locigram/connector-obsidian-sync`
- **Install:** LaunchAgent `com.locigram.obsidian-sync`
- **Language:** TypeScript, Bun runtime

## Inputs
- Index file: `~/.locigram/obsidian-index.json` (written by obsidian-audit)
- Vault: `/Users/surubot/sudobrain/` (env var `OBSIDIAN_VAULT`)
- Only process entries with `verdict: "index"`

## Sync Cursor
- Path: `~/.locigram/obsidian-sync-cursor.json`
- Format: `{ "version": 1, "synced": { "Infrastructure/MCP-Servers.md": { "mtime": "ISO", "locigram_id": "uuid" } } }`
- On each run: compare note mtime to cursor — only process changed files

## Memory Format
Each Locigram memory must be:
1. **Self-contained** — reads standalone with no prior context
2. **Summarized** — 3-5 sentences max (not full note content)
3. **Linked** — includes the Obsidian deep link for full details

Template for memory content:
```
[Summary of the note in 3-5 sentences]. 

Full details: obsidian://open?vault=sudobrain&file=[URL-encoded path without .md]
```

Example:
```
The MCP servers for SuruBot run as K3s pods behind a cloudflared tunnel (k3s-cluster, tunnel ID 8b74f2db). SuruDB MCP (mcp.suru.tools) provides read access to business data — clients, tickets, devices, invoices. Locigram MCP (mcp.locigram.ai) is the personal memory layer. Both use OAuth with dynamic client registration. Pre-registered clients exist for Claude.ai and ChatGPT.

Full details: obsidian://open?vault=sudobrain&file=Infrastructure/MCP-Servers
```

## Locigram Upsert
- URL: env var `LOCIGRAM_MCP_URL` (default `http://10.10.100.82:30310/mcp`)
- Bearer: env var `LOCIGRAM_TOKEN`
- Tool: `memory_remember`
- Key fields:
  - `content`: summary + deep link
  - `locus`: from index entry (e.g. `notes/infrastructure`)
  - `sourceType`: `"sync"`
  - `connector`: `"obsidian-sync"`
  - `source_ref`: `obsidian:<relative-path>` e.g. `obsidian:Infrastructure/MCP-Servers.md`
    (unique index in Locigram ensures upsert behavior — re-saves update in place)

## LLM Summarization
- URL: env var `LLM_URL` (default `http://10.10.100.80:30891/v1`)
- Model: env var `LLM_MODEL`
- Prompt: "Summarize this Obsidian note in 3-5 sentences. Focus on what an AI assistant would need to know to answer questions about this topic. Be specific — include names, URLs, hostnames, and key facts. Do not include formatting, headers, or bullet points in your summary."
- Max input: first 3000 chars of note (truncate if longer)
- If LLM unreachable: use first 300 chars of note as fallback summary, still save

## MCP Client (locigram.ts)
Same pattern as secondbrain-sync — JSON-RPC 2.0 over HTTP.
Try tools/call directly; initialize handshake if needed.

## File Structure
```
packages/connectors/obsidian-sync/
├── src/
│   ├── index.ts        # main: read index, check cursor, sync changed notes
│   ├── vault.ts        # read note content, check mtime
│   ├── llm.ts          # summarize note content
│   ├── locigram.ts     # MCP client (memory_remember upsert)
│   └── cursor.ts       # read/write ~/.locigram/obsidian-sync-cursor.json
├── launchagent/
│   └── com.locigram.obsidian-sync.plist  # nightly 4am
├── package.json
├── tsconfig.json
└── SPEC.md
```

## LaunchAgent plist
- Label: `com.locigram.obsidian-sync`
- Schedule: StartCalendarInterval, hour 4, minute 0
- Env vars: OBSIDIAN_VAULT, LOCIGRAM_MCP_URL, LOCIGRAM_TOKEN, LLM_URL, LLM_MODEL, INDEX_PATH
- Log: `/tmp/com.locigram.obsidian-sync.log`
- KeepAlive: false

## package.json
```json
{
  "name": "@locigram/connector-obsidian-sync",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun run --watch src/index.ts"
  },
  "dependencies": {}
}
```
No external deps — Bun has fs and fetch built in.

## Anti-loop Guarantee
- `source_ref` is unique in Locigram — re-runs UPDATE, never INSERT duplicate
- Locigram → Obsidian write-back is disabled (per Brain/Locigram-Ingestion-Policy.md)
- obsidian-sync only READS vault, never writes to it
- summaries stored in Locigram are derived content, not re-ingested on next audit
  (obsidian-audit skips notes whose content starts with "Full details: obsidian://")
