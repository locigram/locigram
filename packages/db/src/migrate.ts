import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

console.log('[migrate] running migrations...')
const db = createDb(url)
await migrate(db, { migrationsFolder: './migrations' })
console.log('[migrate] done')
process.exit(0)
