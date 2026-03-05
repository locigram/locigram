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
  is_active: boolean
}

export interface Contact {
  client_id: string
  name: string
  email: string | null
  phone: string | null
  role: string | null
}

export interface Device {
  client_id: string
  hostname: string
  os: string | null
  role: string | null
  status: string | null
  last_seen: Date | null
}

export interface Ticket {
  id: number
  client_id: string
  subject: string
  status: string
  created_at: Date
  resolved_at: Date | null
  priority: string | null
}

export interface InvoiceFact {
  customer_name: string
  total_amt: number
  due_date: Date | null
  paid_date: Date | null
  status: string | null
}

export interface Person {
  id: number
  full_name: string
  client_id: string | null
  role: string | null
  email: string | null
  notes: string | null
  last_seen: Date | null
}

export async function getActiveClients(): Promise<Client[]> {
  return sql<Client[]>`SELECT id, name, industry, is_active FROM sync.clients WHERE is_active = true`
}

export async function getContacts(): Promise<Contact[]> {
  return sql<Contact[]>`SELECT client_id, name, email, phone, role FROM sync.contacts`
}

export async function getDevices(): Promise<Device[]> {
  return sql<Device[]>`SELECT client_id, hostname, os, role, status, last_seen FROM sync.devices`
}

export async function getRecentTickets(days: number = 30): Promise<Ticket[]> {
  return sql<Ticket[]>`
    SELECT id, client_id, subject, status, created_at, resolved_at, priority
    FROM sync.tickets
    WHERE created_at >= NOW() - ${days + ' days'}::interval
  `
}

export async function getRecentInvoices(days: number = 90): Promise<InvoiceFact[]> {
  return sql<InvoiceFact[]>`
    SELECT customer_name, total_amt, due_date, paid_date, status
    FROM sync.invoice_facts
    WHERE due_date >= NOW() - ${days + ' days'}::interval
  `
}

export async function getPeople(): Promise<Person[]> {
  return sql<Person[]>`SELECT id, full_name, client_id, role, email, notes, last_seen FROM intel.people`
}
