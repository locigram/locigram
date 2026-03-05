# Locigram — MCP & OpenClaw Integration

Locigram exposes a **Model Context Protocol (MCP)** server at `/mcp`. This is the primary way AI assistants interact with your memory palace.

**Endpoint:** `http://<your-locigram-host>/mcp`
**Auth:** `Authorization: Bearer <API_TOKEN>`
**Transport:** Streamable HTTP

## External LLM Clients (OAuth 2.0)

Locigram implements an OAuth 2.0 Authorization Server so services like **Claude.ai** and **ChatGPT** can connect directly.

### Service Scoping
When an external service connects via OAuth, Locigram automatically scopes their memories:
*   **Claude.ai** → `sessions/claude`
*   **ChatGPT** → `sessions/chatgpt`

### Setup Claude.ai
Claude auto-registers on first connect. You just need to tag the client:
```sql
UPDATE oauth_clients SET service = 'claude' WHERE name = 'Claude';
```

### Setup ChatGPT
Requires a pre-created client ID and secret. Redirect URIs must be updated whenever you create a new connector in the ChatGPT UI.

---

## Wiring to OpenClaw (mcporter)

### Step 1: Add Server
```bash
mcporter config add locigram http://<host>/mcp --header "Authorization=Bearer <token>"
```

### Step 2: SOUL.md Recovery
Add this to your agent's `SOUL.md` to enable compaction recovery:
```markdown
mcporter call locigram.memory_session_start --args '{"locus":"agent/main","lookbackDays":7}'
```

---

## MCP Tool Reference

| Tool | Purpose |
|------|---------|
| `memory_recall` | Semantic search (Qdrant). |
| `memory_context` | Recent memories + hybrid ranking. |
| `memory_session_start` | Post-compaction state recovery. |
| `memory_remember` | Store a new memory unit. |
| `memory_correct` | Supersede old memories with new facts. |
| `people_lookup` | Retrieve full profile for a person entity. |
| `truth_get` | High-confidence reinforced facts. |
| `palace_stats` | Usage and inventory counts. |
