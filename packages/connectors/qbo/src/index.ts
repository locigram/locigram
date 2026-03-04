/**
 * @locigram/connector-qbo
 * QuickBooks Online connector — invoices, payments, vendor bills, time activities.
 *
 * Financial data is pre-classified (no LLM extraction) because:
 * - Data is already perfectly structured
 * - Dollar amounts must be exact — LLM paraphrasing introduces error risk
 * - Customer/vendor names are already known entities
 *
 * Activated by env vars:
 *   LOCIGRAM_QBO_CLIENT_ID
 *   LOCIGRAM_QBO_CLIENT_SECRET
 *   LOCIGRAM_QBO_REALM_ID
 *   LOCIGRAM_QBO_REFRESH_TOKEN
 *   LOCIGRAM_QBO_ACCESS_TOKEN  (optional — refreshed automatically)
 *   LOCIGRAM_QBO_BASE_URL      (optional — defaults to production)
 *   LOCIGRAM_QBO_MINOR_VERSION (optional)
 */

import type { ConnectorPlugin, RawMemory } from '@locigram/core'

export interface QBOConfig {
  clientId:     string
  clientSecret: string
  realmId:      string
  refreshToken: string
  accessToken?: string
  baseUrl?:     string
  minorVersion?: string
}

const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const PAGE_SIZE = 1000

// ── Auth ──────────────────────────────────────────────────────────────────────

async function refreshTokens(config: QBOConfig): Promise<string> {
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.refreshToken }).toString(),
  })
  if (!res.ok) throw new Error(`QBO token refresh failed: ${res.status}`)
  const payload = await res.json() as { access_token?: string }
  if (!payload.access_token) throw new Error('QBO token refresh missing access_token')
  return payload.access_token
}

async function qboGet(config: QBOConfig, path: string, token: string): Promise<unknown> {
  const base = (config.baseUrl ?? 'https://quickbooks.api.intuit.com').replace(/\/$/, '')
  const minorVersion = config.minorVersion
  const url = `${base}${path}${minorVersion ? (path.includes('?') ? '&' : '?') + 'minorversion=' + minorVersion : ''}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) {
    // Token expired — caller should retry with fresh token
    throw Object.assign(new Error('QBO 401'), { code: 'TOKEN_EXPIRED' })
  }
  if (!res.ok) throw new Error(`QBO GET ${path} failed: ${res.status}`)
  return res.json()
}

async function qboQuery(config: QBOConfig, sql: string, token: string): Promise<Record<string, unknown>> {
  const base = (config.baseUrl ?? 'https://quickbooks.api.intuit.com').replace(/\/$/, '')
  const url = `${base}/v3/company/${config.realmId}/query`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/text',
    },
    body: sql,
  })
  if (!res.ok) throw new Error(`QBO query failed: ${res.status}`)
  return res.json() as Promise<Record<string, unknown>>
}

async function fetchAll(config: QBOConfig, entity: string, token: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let start = 1
  while (true) {
    const sql = `SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`
    const payload = await qboQuery(config, sql, token) as Record<string, unknown>
    const qr = payload.QueryResponse as Record<string, unknown> | undefined
    const batch = (qr?.[entity] as unknown[] | undefined) ?? []
    rows.push(...batch.filter(v => v && typeof v === 'object') as Record<string, unknown>[])
    if (batch.length < PAGE_SIZE) break
    start += PAGE_SIZE
  }
  return rows
}

async function fetchCdc(config: QBOConfig, entities: string[], since: Date, token: string): Promise<Record<string, Record<string, unknown>[]>> {
  const base = (config.baseUrl ?? 'https://quickbooks.api.intuit.com').replace(/\/$/, '')
  const url = `${base}/v3/company/${config.realmId}/cdc?entities=${encodeURIComponent(entities.join(','))}&changedSince=${encodeURIComponent(since.toISOString())}`
  const payload = await (await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })).json() as Record<string, unknown>
  const result: Record<string, Record<string, unknown>[]> = {}
  for (const entity of entities) {
    result[entity] = extractFromCdc(payload, entity)
  }
  return result
}

function extractFromCdc(payload: unknown, entity: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  const scan = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(scan); return }
    const rec = node as Record<string, unknown>
    const direct = rec[entity]
    if (Array.isArray(direct)) rows.push(...direct.filter(v => v && typeof v === 'object') as Record<string, unknown>[])
    const qr = rec.QueryResponse as Record<string, unknown> | undefined
    if (qr?.[entity] && Array.isArray(qr[entity])) rows.push(...(qr[entity] as Record<string, unknown>[]).filter(v => v && typeof v === 'object'))
    Object.values(rec).forEach(v => { if (v && typeof v === 'object') scan(v) })
  }
  scan((payload as Record<string, unknown>).CDCResponse ?? payload)
  return rows
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

function num(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) { const n = Number(v); if (isFinite(n)) return n }
  return 0
}

function path(obj: unknown, keys: string[]): unknown {
  let cur = obj
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function fmt(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
}

function locus(clientName?: string): string {
  if (!clientName) return 'business/unknown'
  return `business/${clientName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'unknown'}`
}

// ── Transformers → RawMemory ──────────────────────────────────────────────────

function invoiceToMemory(row: Record<string, unknown>): RawMemory | null {
  const id = str(row.Id)
  if (!id) return null

  const customerName = str(path(row, ['CustomerRef', 'name'])) ?? 'Unknown Customer'
  const txnDate      = str(row.TxnDate)
  const dueDate      = str(row.DueDate)
  const totalAmt     = num(row.TotalAmt)
  const balance      = num(row.Balance)
  const currency     = str(path(row, ['CurrencyRef', 'value'])) ?? 'USD'

  // Classify line items: recurring (MRR) vs project
  let recurringAmt = 0
  let projectAmt   = 0
  for (const line of (Array.isArray(row.Line) ? row.Line : []) as Record<string, unknown>[]) {
    const itemName = str(path(line, ['SalesItemLineDetail', 'ItemRef', 'name'])) ?? ''
    const amount   = num(line.Amount)
    if (isRecurringItem(itemName)) recurringAmt += amount
    else projectAmt += amount
  }

  const parts = [
    `Invoice for ${customerName}: ${fmt(totalAmt, currency)} total`,
    recurringAmt > 0 ? `(${fmt(recurringAmt, currency)} recurring MRR, ${fmt(projectAmt, currency)} project)` : null,
    txnDate ? `dated ${txnDate}` : null,
    dueDate ? `due ${dueDate}` : null,
    balance > 0 ? `Outstanding balance: ${fmt(balance, currency)}` : 'Paid in full',
  ].filter(Boolean).join(' — ')

  return {
    content:    parts,
    sourceType: 'invoice',
    sourceRef:  `qbo:invoice:${id}`,
    occurredAt: txnDate ? new Date(txnDate) : undefined,
    preClassified: {
      locus:       locus(customerName),
      entities:    [customerName],
      isReference: true,            // invoices are stable reference facts
      referenceType: 'contract',    // financial agreement
      clientId:    str(path(row, ['CustomerRef', 'value'])),
      importance:  balance > 5000 ? 'high' : balance > 0 ? 'normal' : 'low',
    },
    metadata: {
      connector:     'qbo',
      qbo_id:        id,
      customer_id:   str(path(row, ['CustomerRef', 'value'])),
      customer_name: customerName,
      txn_date:      txnDate,
      due_date:      dueDate,
      total_amt:     totalAmt,       // exact — never rely on content string for math
      recurring_amt: recurringAmt,
      project_amt:   projectAmt,
      balance:       balance,
      currency,
      private_note:  str(row.PrivateNote),
    },
  }
}

function paymentToMemory(row: Record<string, unknown>): RawMemory | null {
  const id = str(row.Id)
  if (!id) return null

  const customerName  = str(path(row, ['CustomerRef', 'name'])) ?? 'Unknown Customer'
  const txnDate       = str(row.TxnDate)
  const totalAmt      = num(row.TotalAmt)
  const unappliedAmt  = num(row.UnappliedAmt)
  const currency      = 'USD'

  const content = [
    `${customerName} paid ${fmt(totalAmt, currency)}`,
    txnDate ? `on ${txnDate}` : null,
    unappliedAmt > 0 ? `(${fmt(unappliedAmt)} unapplied)` : null,
  ].filter(Boolean).join(' ')

  return {
    content,
    sourceType: 'payment',
    sourceRef:  `qbo:payment:${id}`,
    occurredAt: txnDate ? new Date(txnDate) : undefined,
    preClassified: {
      locus:       locus(customerName),
      entities:    [customerName],
      isReference: false,           // payment is an event, not a stable reference
      importance:  totalAmt > 5000 ? 'high' : 'normal',
      clientId:    str(path(row, ['CustomerRef', 'value'])),
    },
    metadata: {
      connector:      'qbo',
      qbo_id:         id,
      customer_id:    str(path(row, ['CustomerRef', 'value'])),
      customer_name:  customerName,
      txn_date:       txnDate,
      total_amt:      totalAmt,
      unapplied_amt:  unappliedAmt,
      currency,
    },
  }
}

function vendorBillToMemory(row: Record<string, unknown>): RawMemory | null {
  const id = str(row.Id)
  if (!id) return null

  const vendorName = str(path(row, ['VendorRef', 'name'])) ?? 'Unknown Vendor'
  const txnDate    = str(row.TxnDate)
  const dueDate    = str(row.DueDate)
  const totalAmt   = num(row.TotalAmt)
  const balance    = num(row.Balance)

  const content = [
    `Vendor bill from ${vendorName}: ${fmt(totalAmt)}`,
    dueDate ? `due ${dueDate}` : null,
    balance > 0 ? `Outstanding: ${fmt(balance)}` : 'Paid',
  ].filter(Boolean).join(' — ')

  return {
    content,
    sourceType: 'bill',
    sourceRef:  `qbo:bill:${id}`,
    occurredAt: txnDate ? new Date(txnDate) : undefined,
    preClassified: {
      locus:         `business/${vendorName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`,
      entities:      [vendorName],
      isReference:   true,
      referenceType: 'contract',
      importance:    balance > 2000 ? 'high' : 'normal',
    },
    metadata: {
      connector:   'qbo',
      qbo_id:      id,
      vendor_id:   str(path(row, ['VendorRef', 'value'])),
      vendor_name: vendorName,
      txn_date:    txnDate,
      due_date:    dueDate,
      total_amt:   totalAmt,
      balance,
    },
  }
}

function timeActivityToMemory(row: Record<string, unknown>): RawMemory | null {
  const id = str(row.Id)
  if (!id) return null

  const customerName = str(path(row, ['CustomerRef', 'name'])) ?? 'Unknown Customer'
  const worker       = str(path(row, ['EmployeeRef', 'name'])) ?? str(path(row, ['VendorRef', 'name'])) ?? 'Unknown'
  const txnDate      = str(row.TxnDate)
  const hours        = num(row.Hours) + (num(row.Minutes) / 60)
  const hourlyRate   = num(row.HourlyRate)
  const billable     = str(row.BillableStatus) ?? 'NotBillable'

  const content = [
    `${hours.toFixed(1)}h ${billable === 'Billable' ? 'billable' : 'non-billable'} time logged for ${customerName}`,
    `by ${worker}`,
    txnDate ? `on ${txnDate}` : null,
    hourlyRate > 0 ? `at ${fmt(hourlyRate)}/hr` : null,
  ].filter(Boolean).join(' ')

  return {
    content,
    sourceType: 'timesheet',
    sourceRef:  `qbo:timeactivity:${id}`,
    occurredAt: txnDate ? new Date(txnDate) : undefined,
    preClassified: {
      locus:       locus(customerName),
      entities:    [customerName, worker],
      isReference: false,   // time activity is an event
      clientId:    str(path(row, ['CustomerRef', 'value'])),
    },
    metadata: {
      connector:       'qbo',
      qbo_id:          id,
      customer_id:     str(path(row, ['CustomerRef', 'value'])),
      customer_name:   customerName,
      worker,
      txn_date:        txnDate,
      hours:           parseFloat(hours.toFixed(2)),
      hourly_rate:     hourlyRate,
      billable_status: billable,
    },
  }
}

// Item classification (recurring MRR vs project) — MSP-specific logic
function isRecurringItem(name: string): boolean {
  const n = name.trim().toLowerCase()
  if (!n) return false
  if (n.startsWith('endpt-')) return true
  const patterns = ['dedicated server', 'security suite', 'backup', 'vpn', 'duo', 'microsoft 365', 'm365', 'copilot', 'storage', 'hdd']
  return patterns.some(p => n.includes(p))
}

// ── Connector Plugin ──────────────────────────────────────────────────────────

export const qboPlugin: ConnectorPlugin = {
  name:    'qbo',
  version: '0.1.0',
  configSchema: {
    parse: (cfg: unknown) => {
      const c = cfg as Record<string, unknown>
      if (!c.clientId || !c.clientSecret || !c.realmId || !c.refreshToken) {
        throw new Error('QBO connector requires clientId, clientSecret, realmId, refreshToken')
      }
      return cfg
    },
  } as any,

  create(rawConfig: unknown) {
    const config = rawConfig as QBOConfig

    return {
      name: 'qbo',

      async pull(opts?: { since?: Date }): Promise<RawMemory[]> {
        let token = config.accessToken ?? await refreshTokens(config)
        const results: RawMemory[] = []

        const entities = ['Invoice', 'Payment', 'Bill', 'TimeActivity']
        let raw: Record<string, Record<string, unknown>[]> = {}

        try {
          if (opts?.since) {
            raw = await fetchCdc(config, entities, opts.since, token)
          } else {
            raw = {
              Invoice:      await fetchAll(config, 'Invoice', token),
              Payment:      await fetchAll(config, 'Payment', token),
              Bill:         await fetchAll(config, 'Bill', token),
              TimeActivity: await fetchAll(config, 'TimeActivity', token),
            }
          }
        } catch (err: any) {
          if (err?.code === 'TOKEN_EXPIRED') {
            token = await refreshTokens(config)
            // Retry once
            raw = opts?.since
              ? await fetchCdc(config, entities, opts.since, token)
              : {
                  Invoice:      await fetchAll(config, 'Invoice', token),
                  Payment:      await fetchAll(config, 'Payment', token),
                  Bill:         await fetchAll(config, 'Bill', token),
                  TimeActivity: await fetchAll(config, 'TimeActivity', token),
                }
          } else throw err
        }

        for (const row of raw.Invoice ?? []) {
          const m = invoiceToMemory(row); if (m) results.push(m)
        }
        for (const row of raw.Payment ?? []) {
          const m = paymentToMemory(row); if (m) results.push(m)
        }
        for (const row of raw.Bill ?? []) {
          const m = vendorBillToMemory(row); if (m) results.push(m)
        }
        for (const row of raw.TimeActivity ?? []) {
          const m = timeActivityToMemory(row); if (m) results.push(m)
        }

        return results
      },
    }
  },
}

export default qboPlugin
