# secondbrain-sync — Build Spec

## Purpose
Nightly K3s CronJob that queries SuruDB, synthesizes business data into
natural-language memory statements, and saves them to Locigram via the
memory_remember tool. Part of the Locigram connectors framework.

Name is `secondbrain-sync` not `surudb-sync` because it can eventually
support other sources (Obsidian, Notion, etc.) — SuruDB is just the first.

## Package
- Name: `@locigram/connector-secondbrain-sync`
- Location: `packages/connectors/secondbrain-sync/`
- Pattern: follow `packages/connectors/session-monitor/` for structure
- Language: TypeScript, Bun runtime (consistent with Locigram monorepo)

## Data Sources (Postgres — suru DB)
Connection via env var `DATABASE_URL`:
`postgresql://surubot:200454af1bfec8c0ca997b66c70ab22d76fbf5c5ed91ddc3@10.10.100.90:30543/suru`
Within K3s: `postgresql://surubot:200454af1bfec8c0ca997b66c70ab22d76fbf5c5ed91ddc3@postgres.surullc:5432/suru`

Key tables:
- `sync.clients` — id (TEXT), name, industry, is_active
- `sync.contacts` — client_id (TEXT), name, email, phone, role
- `sync.devices` — client_id (TEXT), hostname, os, role, status, last_seen
- `sync.tickets` — id, client_id (TEXT), subject, status, created_at, resolved_at, priority
- `sync.invoice_facts` — customer_name, total_amt, due_date, paid_date, status
- `intel.people` — id, full_name, client_id (TEXT), role, email, notes, last_seen

## LLM Synthesis
OpenAI-compatible API via env var `LLM_URL` (default: `http://10.10.100.80:30891/v1`):
- Model: whatever is loaded (use `qwen3.5-35b-a3b` or read from env `LLM_MODEL`)
- No API key required (or use empty string)
- If unreachable: fall back to template-based strings, do NOT abort

## Locigram MCP Client
- URL via env var `LOCIGRAM_MCP_URL` (default: `http://locigram-server.locigram-main:3000/mcp`)
- Bearer token via env var `LOCIGRAM_TOKEN`
- Tool: `memory_remember`
- Protocol: JSON-RPC 2.0 over HTTP
- Try tools/call directly first. If server requires initialize handshake, do it then retry.

MCP call:
```json
POST /mcp
Authorization: Bearer <token>
Content-Type: application/json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_remember","arguments":{"content":"...","locus":"notes/observations","sourceType":"sync"}}}
```

## Sync Cursor
Track in Postgres `public.kv` (key: `secondbrain_sync_cursor`):
```sql
CREATE TABLE IF NOT EXISTS public.kv (key TEXT PRIMARY KEY, value TEXT);
```
Value: `{"lastRun":"ISO timestamp","version":1}`

## Data Categories & Locus Mapping

### 1. Client Profiles → `notes/observations`
- One memory per active client
- Include: name, industry, device count, primary contact, recent ticket summary
- Example: "Accudata & Co is Suru's largest client (~76% revenue). 100 devices, accounting industry. Primary contact: Jane Smith. Stack includes Lacerte, QuickBooks. 3 open tickets as of March 2026."

### 2. Device Summaries → `notes/observations`
- One memory per client (grouped, not per device)
- Flag: offline >7 days, Windows 10 (EOL risk)
- Example: "Bridgecreek Realty has 13 devices. 2 offline >7 days. Mix of Windows 10/11 — 4 devices still on Windows 10."

### 3. Ticket Patterns → `notes/lessons`
- Query last 30 days, group by client + subject similarity
- Only save patterns (3+ similar) or unresolved high-priority
- Example: "Recurring issue at Valentina Diamonds: Outlook freezes on Windows 11 — 3 tickets in 30 days, unresolved."

### 4. Key Contacts → `notes/people`
- One memory per person from intel.people
- Template-based: "Jane Smith is the IT Manager at Accudata (jane@accudataco.com)."

### 5. Financial Snapshot → `notes/observations`
- One memory: overall snapshot (MRR estimate, top clients, slow payers)
- Query last 90 days of invoice_facts
- Example: "Suru Solutions financial snapshot (March 2026): ~$X MRR across 8 clients. Bridgecreek consistently pays late (>Net-30)."

## Memory Format Rules
- Every memory self-contained — no pronouns without antecedent
- Include "As of [Month Year]" for snapshot memories
- No raw IDs, no schema field names, no JSON
- No credentials, tokens, or passwords — EVER

## File Structure
```
packages/connectors/secondbrain-sync/
├── src/
│   ├── index.ts          # main entrypoint, orchestrates sync
│   ├── db.ts             # postgres queries (use `postgres` package)
│   ├── locigram.ts       # MCP client (memory_remember)
│   ├── llm.ts            # LLM synthesis + template fallback
│   ├── synthesize.ts     # transforms raw DB data → memory statements
│   └── cursor.ts         # sync cursor read/write
├── k8s/
│   └── cronjob.yaml      # K3s CronJob, namespace surullc, schedule 0 3 * * *
├── package.json          # @locigram/connector-secondbrain-sync
├── tsconfig.json
└── SPEC.md
```

## package.json
```json
{
  "name": "@locigram/connector-secondbrain-sync",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun run --watch src/index.ts"
  },
  "dependencies": {
    "postgres": "latest"
  }
}
```

## k8s/cronjob.yaml
- namespace: `surullc`
- schedule: `0 3 * * *`
- image: `ghcr.io/sudobot99/locigram-secondbrain-sync:latest`
- restartPolicy: OnFailure
- Env vars from secret `secondbrain-sync-secrets` (keys: DATABASE_URL, LOCIGRAM_TOKEN, LOCIGRAM_MCP_URL, LLM_URL, LLM_MODEL)
- Resources: requests 128Mi/100m, limits 256Mi/300m

## DO NOT
- Add a Dockerfile (CI/CD will handle builds from the monorepo)
- Use node-fetch (Bun has fetch built in)
- Use any Locigram internal packages (keep this connector self-contained for portability)
- Touch any other packages in the monorepo
