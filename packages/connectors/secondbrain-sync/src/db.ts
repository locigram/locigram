import postgres from 'postgres'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[secondbrain-sync] DATABASE_URL is required')
  process.exit(1)
}

export const sql = postgres(DATABASE_URL)

export interface Client {
  id: string
  name: string
  industry: string | null
  active: boolean
}

export interface Device {
  id: string
  org_id: string
  system_name: string
  dns_name: string | null
  node_class: string | null
  os_name: string | null
  offline: boolean | null
  last_contact: Date | null
  last_logged_in_user: string | null
}

export interface Ticket {
  id: number
  client_id: string
  client_name: string | null
  summary: string
  status_name: string | null
  priority_name: string | null
  date_occurred: Date | null
  date_closed: Date | null
  agent_name: string | null
}

export interface InvoiceFact {
  customer_name: string
  total_amt: number
  due_date: Date | null
  balance: number | null
}

export interface Person {
  id: number
  name: string
  client_id: string | null
  role: string | null
  email: string | null
  notes: string | null
  last_interaction: Date | null
}

// ── Full pulls (used on first run or when no cursor) ──────────────────────

export async function getActiveClients(): Promise<Client[]> {
  return sql<Client[]>`SELECT id, name, industry, active FROM sync.clients WHERE active = true`
}

export async function getDevices(): Promise<Device[]> {
  return sql<Device[]>`
    SELECT id, org_id, system_name, dns_name, node_class, os_name, offline, last_contact, last_logged_in_user
    FROM sync.ninjaone_devices
    ORDER BY system_name
  `
}

export async function getRecentTickets(days: number = 30): Promise<Ticket[]> {
  return sql<Ticket[]>`
    SELECT id, client_id, client_name, summary, status_name, priority_name, date_occurred, date_closed, agent_name
    FROM sync.halopsa_tickets
    WHERE date_occurred >= NOW() - (${days} || ' days')::interval
    ORDER BY date_occurred DESC
  `
}

export async function getRecentInvoices(days: number = 90): Promise<InvoiceFact[]> {
  return sql<InvoiceFact[]>`
    SELECT customer_name, total_amt, due_date, balance
    FROM sync.invoice_facts
    WHERE due_date >= NOW() - (${days} || ' days')::interval
    ORDER BY due_date DESC
  `
}

export async function getPeople(): Promise<Person[]> {
  return sql<Person[]>`
    SELECT id, name, client_id, role, email, notes, last_interaction
    FROM intel.people
    ORDER BY last_interaction DESC NULLS LAST
  `
}

// ── Incremental pulls (only records changed since last run) ───────────────

export async function getClientsChangedSince(since: Date): Promise<Client[]> {
  // clients table may not have updated_at — pull all active (small table)
  return getActiveClients()
}

export async function getDevicesChangedSince(since: Date): Promise<Device[]> {
  return sql<Device[]>`
    SELECT id, org_id, system_name, dns_name, node_class, os_name, offline, last_contact, last_logged_in_user
    FROM sync.ninjaone_devices
    WHERE last_contact >= ${since} OR last_contact IS NULL
    ORDER BY system_name
  `
}

export async function getTicketsChangedSince(since: Date): Promise<Ticket[]> {
  return sql<Ticket[]>`
    SELECT id, client_id, client_name, summary, status_name, priority_name, date_occurred, date_closed, agent_name
    FROM sync.halopsa_tickets
    WHERE date_occurred >= ${since} OR (date_closed IS NOT NULL AND date_closed >= ${since})
    ORDER BY date_occurred DESC
  `
}

export async function getInvoicesChangedSince(since: Date): Promise<InvoiceFact[]> {
  return sql<InvoiceFact[]>`
    SELECT customer_name, total_amt, due_date, balance
    FROM sync.invoice_facts
    WHERE due_date >= ${since}
    ORDER BY due_date DESC
  `
}

export async function getPeopleChangedSince(since: Date): Promise<Person[]> {
  return sql<Person[]>`
    SELECT id, name, client_id, role, email, notes, last_interaction
    FROM intel.people
    WHERE updated_at >= ${since} OR created_at >= ${since}
    ORDER BY last_interaction DESC NULLS LAST
  `
}
