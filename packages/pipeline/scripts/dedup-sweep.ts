#!/usr/bin/env bun
/**
 * Standalone dedup sweep CLI — wraps the library function for manual/CronJob use.
 * The primary runner is now the in-process maintenance scheduler.
 *
 * Usage: DATABASE_URL=... bun run scripts/dedup-sweep.ts [--dry-run]
 */

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '@locigram/db'
import { runDedup } from '../src/dedup-sweep'

const DRY_RUN = process.argv.includes('--dry-run')
const DB_URL = process.env.DATABASE_URL
if (!DB_URL) { console.error('[dedup] DATABASE_URL is required'); process.exit(1) }

const palaceId = process.env.PALACE_ID ?? 'main'
const client = postgres(DB_URL, { max: 5 })
const db = drizzle(client, { schema })

const result = await runDedup(db, palaceId, DRY_RUN)
console.log(JSON.stringify(result, null, 2))

await client.end()
process.exit(0)
