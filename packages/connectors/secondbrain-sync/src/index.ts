import {
  sql,
  getActiveClients, getDevices, getRecentTickets, getRecentInvoices, getPeople,
  getClientsChangedSince, getDevicesChangedSince, getTicketsChangedSince,
  getInvoicesChangedSince, getPeopleChangedSince,
} from './db'
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
  const isIncremental = !!cursor
  const since = cursor ? new Date(cursor.lastRun) : null

  if (isIncremental) {
    console.log(`[secondbrain-sync] Incremental sync since ${cursor.lastRun}`)
  } else {
    console.log('[secondbrain-sync] Full sync (no cursor found)')
  }

  // Fetch data — incremental if we have a cursor, full otherwise
  const [clients, devices, tickets, invoices, people] = await Promise.all([
    // Clients always full (small table, no reliable updated_at)
    getActiveClients(),
    // Devices, tickets, invoices, people — incremental when possible
    since ? getDevicesChangedSince(since) : getDevices(),
    since ? getTicketsChangedSince(since) : getRecentTickets(30),
    since ? getInvoicesChangedSince(since) : getRecentInvoices(90),
    since ? getPeopleChangedSince(since) : getPeople(),
  ])

  console.log(
    `[secondbrain-sync] Data loaded: ${clients.length} clients, ${devices.length} devices, ${tickets.length} tickets, ${invoices.length} invoices, ${people.length} people`,
  )

  // On incremental: skip categories with no changed data
  // Client profiles + device summaries re-synthesize for clients with changed devices/tickets
  const changedClientIds = new Set<string>([
    ...devices.map(d => d.org_id),
    ...tickets.map(t => t.client_id),
  ])

  const clientsToSynthesize = isIncremental
    ? clients.filter(c => changedClientIds.has(c.id))
    : clients

  const categories: Array<{ name: string; entries: Promise<MemoryEntry[]>; skip?: boolean }> = [
    {
      name: 'Client Profiles',
      entries: synthesizeClientProfiles(clientsToSynthesize, devices, tickets),
      skip: isIncremental && clientsToSynthesize.length === 0,
    },
    {
      name: 'Device Summaries',
      entries: synthesizeDeviceSummaries(clientsToSynthesize, devices),
      skip: isIncremental && devices.length === 0,
    },
    {
      name: 'Ticket Patterns',
      entries: synthesizeTicketPatterns(clientsToSynthesize, tickets),
      skip: isIncremental && tickets.length === 0,
    },
    {
      name: 'Key Contacts',
      entries: synthesizeKeyContacts(people),
      skip: isIncremental && people.length === 0,
    },
    {
      name: 'Financial Snapshot',
      entries: synthesizeFinancialSnapshot(invoices),
      skip: isIncremental && invoices.length === 0,
    },
  ]

  let totalSaved = 0

  for (const category of categories) {
    if (category.skip) {
      console.log(`[secondbrain-sync] ${category.name}: skipped (no changes)`)
      continue
    }

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
