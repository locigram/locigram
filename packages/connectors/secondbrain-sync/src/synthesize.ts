import type { Client, Device, Ticket, InvoiceFact, Person } from './db'
import { synthesizeWithLLM } from './llm'

const SYSTEM_PROMPT = `You are a business intelligence summarizer for Suru Solutions, a managed IT services company.
Write concise, self-contained memory statements. No raw IDs or schema field names. No JSON.
Include "As of [Month Year]" for snapshot data. Every statement must be self-contained — no pronouns without antecedent.
Never include credentials, tokens, or passwords.`

function monthYear(): string {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export interface MemoryEntry {
  content: string
  locus: string
  sourceRef: string
}

export async function synthesizeClientProfiles(
  clients: Client[],
  devices: Device[],
  tickets: Ticket[],
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = []

  for (const client of clients) {
    const clientDevices = devices.filter((d) => d.org_id === client.id)
    const clientTickets = tickets.filter((t) => t.client_id === client.id)
    const openTickets = clientTickets.filter((t) =>
      t.status_name && !['closed', 'resolved', 'completed'].includes(t.status_name.toLowerCase())
    )

    const fallback = [
      `${client.name} is a Suru Solutions client`,
      client.industry ? ` in the ${client.industry} industry` : '',
      `. ${clientDevices.length} devices managed.`,
      ` ${openTickets.length} open ticket(s) as of ${monthYear()}.`,
    ].join('')

    const userPrompt = [
      `Client: ${client.name}`,
      `Industry: ${client.industry ?? 'unknown'}`,
      `Devices: ${clientDevices.length}`,
      `Open tickets: ${openTickets.length}`,
      `Recent ticket subjects: ${clientTickets.slice(0, 5).map((t) => t.summary).join('; ') || 'none'}`,
    ].join('\n')

    const content = await synthesizeWithLLM(
      SYSTEM_PROMPT,
      `Summarize this client profile in one paragraph:\n${userPrompt}`,
      fallback,
    )

    entries.push({ content, locus: 'notes/observations', sourceRef: `surudb:client:${client.id}` })
  }

  return entries
}

export async function synthesizeDeviceSummaries(
  clients: Client[],
  devices: Device[],
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = []
  const now = Date.now()
  const sevenDays = 7 * 24 * 60 * 60 * 1000

  for (const client of clients) {
    const clientDevices = devices.filter((d) => d.org_id === client.id)
    if (clientDevices.length === 0) continue

    const offline7d = clientDevices.filter(
      (d) => d.last_contact && now - new Date(d.last_contact).getTime() > sevenDays,
    )
    const win10 = clientDevices.filter((d) => d.os_name?.toLowerCase().includes('windows 10'))

    const fallback = [
      `${client.name} has ${clientDevices.length} device(s).`,
      offline7d.length > 0 ? ` ${offline7d.length} offline >7 days.` : '',
      win10.length > 0 ? ` ${win10.length} still on Windows 10 (EOL risk).` : '',
      ` As of ${monthYear()}.`,
    ].join('')

    const userPrompt = [
      `Client: ${client.name}`,
      `Total devices: ${clientDevices.length}`,
      `Offline >7 days: ${offline7d.length} (${offline7d.map((d) => d.system_name).join(', ') || 'none'})`,
      `Windows 10 devices: ${win10.length}`,
      `OS breakdown: ${[...new Set(clientDevices.map((d) => d.os_name).filter(Boolean))].join(', ') || 'unknown'}`,
    ].join('\n')

    const content = await synthesizeWithLLM(
      SYSTEM_PROMPT,
      `Summarize device status for this client in one paragraph:\n${userPrompt}`,
      fallback,
    )

    entries.push({ content, locus: 'notes/observations', sourceRef: `surudb:devices:${client.id}` })
  }

  return entries
}

export async function synthesizeTicketPatterns(
  clients: Client[],
  tickets: Ticket[],
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = []

  for (const client of clients) {
    const clientTickets = tickets.filter((t) => t.client_id === client.id)
    if (clientTickets.length === 0) continue

    // Group by rough subject similarity (first 30 chars lowercase)
    const groups = new Map<string, Ticket[]>()
    for (const t of clientTickets) {
      const key = t.summary.toLowerCase().slice(0, 30).trim()
      const arr = groups.get(key) ?? []
      arr.push(t)
      groups.set(key, arr)
    }

    // Only patterns with 3+ similar tickets or unresolved high-priority
    const patterns = [...groups.entries()].filter(
      ([, tix]) =>
        tix.length >= 3 ||
        tix.some((t) =>
          t.priority_name?.toLowerCase() === 'high' &&
          !['closed', 'resolved', 'completed'].includes(t.status_name?.toLowerCase() ?? '')
        ),
    )

    if (patterns.length === 0) continue

    const fallback = patterns
      .map(([, tix]) => {
        const sample = tix[0]
        return `Recurring issue at ${client.name}: "${sample.summary}" — ${tix.length} ticket(s) in last 30 days.`
      })
      .join(' ')

    const userPrompt = patterns
      .map(([, tix]) => {
        const sample = tix[0]
        const unresolved = tix.filter((t) =>
          !['closed', 'resolved', 'completed'].includes(t.status_name?.toLowerCase() ?? '')
        ).length
        return `- "${sample.summary}" x${tix.length}, ${unresolved} unresolved, priority: ${sample.priority_name ?? 'normal'}`
      })
      .join('\n')

    const content = await synthesizeWithLLM(
      SYSTEM_PROMPT,
      `Summarize ticket patterns for ${client.name} in the last 30 days:\n${userPrompt}`,
      fallback,
    )

    entries.push({ content, locus: 'notes/lessons', sourceRef: `surudb:tickets:${client.id}` })
  }

  return entries
}

export async function synthesizeKeyContacts(people: Person[]): Promise<MemoryEntry[]> {
  return people.map((p) => {
    const parts = [
      `${p.name}`,
      p.role ? ` is the ${p.role}` : '',
      p.client_id ? ` at client ${p.client_id}` : '',
      p.email ? ` (${p.email})` : '',
      '.',
      p.notes ? ` ${p.notes}` : '',
    ]
    return {
      content: parts.join(''),
      locus: 'notes/people',
      sourceRef: `surudb:person:${p.id}`,
    }
  })
}

export async function synthesizeFinancialSnapshot(
  invoices: InvoiceFact[],
): Promise<MemoryEntry[]> {
  if (invoices.length === 0) return []

  const totalRevenue = invoices.reduce((sum, inv) => sum + Number(inv.total_amt), 0)
  const uniqueCustomers = [...new Set(invoices.map((i) => i.customer_name))]
  const mrr = Math.round(totalRevenue / 3)

  // Find late payers (paid after due date)
  // Find clients with outstanding balances
  const withBalance = invoices.filter((i) => i.balance && Number(i.balance) > 0)
  const balanceByCustomer = new Map<string, number>()
  for (const inv of withBalance) {
    balanceByCustomer.set(inv.customer_name, (balanceByCustomer.get(inv.customer_name) ?? 0) + Number(inv.balance))
  }
  const frequentLatePayers = [...balanceByCustomer.entries()]
    .filter(([, bal]) => bal > 500)
    .map(([name]) => name)

  const fallback = [
    `Suru Solutions financial snapshot (${monthYear()}):`,
    ` ~$${mrr.toLocaleString()} estimated MRR across ${uniqueCustomers.length} client(s).`,
    frequentLatePayers.length > 0
      ? ` ${frequentLatePayers.join(', ')} consistently pay(s) late (>Net-30).`
      : '',
  ].join('')

  const userPrompt = [
    `Period: last 90 days`,
    `Total revenue: $${totalRevenue.toLocaleString()}`,
    `Estimated MRR: $${mrr.toLocaleString()}`,
    `Clients: ${uniqueCustomers.join(', ')}`,
    `Frequent late payers: ${frequentLatePayers.join(', ') || 'none'}`,
  ].join('\n')

  const content = await synthesizeWithLLM(
    SYSTEM_PROMPT,
    `Write a financial snapshot summary in one paragraph:\n${userPrompt}`,
    fallback,
  )

  return [{ content, locus: 'notes/observations', sourceRef: 'surudb:financial:snapshot' }]
}
