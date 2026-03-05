import { sql, getActiveClients, getContacts, getDevices, getRecentTickets, getRecentInvoices, getPeople } from './db'
import { ensureKvTable, readCursor, writeCursor } from './cursor'
import { rememberMemory } from './locigram'
import {
  synthesizeClientProfiles,
  synthesizeDeviceSummaries,
  synthesizeTicketPatterns,
  synthesizeKeyContacts,
  synthesizeFinancialSnapshot,
} from './synthesize'
import type { MemoryEntry } from './synthesize'

async function main() {
  console.log('[secondbrain-sync] Starting sync...')

  await ensureKvTable(sql)
  const cursor = await readCursor(sql)
  if (cursor) {
    console.log(`[secondbrain-sync] Last run: ${cursor.lastRun}`)
  }

  // Fetch all data in parallel
  const [clients, contacts, devices, tickets, invoices, people] = await Promise.all([
    getActiveClients(),
    getContacts(),
    getDevices(),
    getRecentTickets(30),
    getRecentInvoices(90),
    getPeople(),
  ])

  console.log(
    `[secondbrain-sync] Data loaded: ${clients.length} clients, ${contacts.length} contacts, ${devices.length} devices, ${tickets.length} tickets, ${invoices.length} invoices, ${people.length} people`,
  )

  // Synthesize all categories
  const categories: Array<{ name: string; entries: Promise<MemoryEntry[]> }> = [
    { name: 'Client Profiles', entries: synthesizeClientProfiles(clients, contacts, devices, tickets) },
    { name: 'Device Summaries', entries: synthesizeDeviceSummaries(clients, devices) },
    { name: 'Ticket Patterns', entries: synthesizeTicketPatterns(clients, tickets) },
    { name: 'Key Contacts', entries: synthesizeKeyContacts(people) },
    { name: 'Financial Snapshot', entries: synthesizeFinancialSnapshot(invoices) },
  ]

  let totalSaved = 0

  for (const category of categories) {
    const entries = await category.entries
    console.log(`[secondbrain-sync] ${category.name}: ${entries.length} memories`)

    for (const entry of entries) {
      await rememberMemory(entry.content, entry.locus, entry.sourceRef)
      totalSaved++
    }
  }

  await writeCursor(sql)
  console.log(`[secondbrain-sync] Done. ${totalSaved} memories saved.`)

  await sql.end()
  process.exit(0)
}

main().catch((err) => {
  console.error('[secondbrain-sync] Fatal error:', err)
  process.exit(1)
})
