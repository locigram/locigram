# Locigram

> Self-hosted AI memory platform. Your memories never leave your infrastructure.

Locigram is an open-source memory layer for AI assistants — addressable via MCP and REST, deployable anywhere, owned entirely by you.

## Concepts

- **Locigram** — an individual memory unit
- **Truth** — a reinforced fact built from multiple locigrams, with confidence scoring and decay
- **Palace** — one user or org's complete memory store
- **Locus** — a namespace (`people/`, `business/`, `project/<name>`, etc.)

## Quick Start

```bash
cp deploy/docker/.env.example deploy/docker/.env
# edit .env with your values
docker-compose -f deploy/docker/docker-compose.yml up
```

API available at `http://localhost:3000`  
MCP server available at `http://localhost:3001`

## Architecture

- **Postgres** — structured memory (locigrams, truths, entities)
- **Qdrant** — vector search (semantic recall)
- **TypeScript + Bun** — fast, single binary
- **Hono** — REST API
- **@modelcontextprotocol/sdk** — MCP server (Streamable HTTP)

## Packages

| Package | Purpose |
|---------|---------|
| `@locigram/core` | Shared types and interfaces |
| `@locigram/db` | Drizzle schema + migrations |
| `@locigram/api` | Hono REST API server |
| `@locigram/mcp` | MCP server |
| `@locigram/pipeline` | Ingestion + LLM extraction |
| `@locigram/truth` | Truth engine |
| `@locigram/vector` | Qdrant wrapper |
| `@locigram/connector-*` | Data source connectors |

## Status

🚧 Early development — not ready for production use.
