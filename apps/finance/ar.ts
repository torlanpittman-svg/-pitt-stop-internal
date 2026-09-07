/**
 * Real production QuickBooks A/R — persistence + read model.
 *
 * persistArSnapshot(): pulls OPEN invoices from the authoritative production company and writes a
 * point-in-time snapshot (append-only) with aging + dealer/retail classification. FAIL-CLOSED: it
 * refuses to persist unless the live connection is the owner-confirmed production realm, so the
 * QuickBooks sandbox sample company can never become CFO truth. Runs inside the production cron
 * (where tokens decrypt); read-only toward QuickBooks.
 *
 * getArSnapshot(): the latest snapshot for the production realm → total, aging, dealer/retail/unknown.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finArInvoices } from './schema'
import { assertCfoProductionRealm, agingOf, classifyReceivable, CFO_PRODUCTION_REALM, type AgingBucket } from './qb-cfo'
import { logger } from '@/platform/logger'

const APP = 'finance:ar'
/* eslint-disable @typescript-eslint/no-explicit-any */
const cents = (n: any) => Math.round((typeof n === 'number' ? n : parseFloat(n) || 0) * 100)

export interface ArPersistResult { ok: boolean; captured?: string; count?: number; totalCents?: number; realmId?: string; environment?: string; skipped?: string }

/** Pull open invoices and write a fresh A/R snapshot. Fail-closed to the production realm. */
export async function persistArSnapshot(actor: string | null): Promise<ArPersistResult> {
  const { getValidAccessToken } = await import('@/apps/quickbooks/connection')
  const { queryQBO } = await import('@/apps/quickbooks/client')
  const db = getDb()

  let realmId = '', environment = ''
  try { const tok = await getValidAccessToken(); realmId = tok.realmId; environment = tok.environment } catch (e) {
    logger.warn(APP, 'no_qb_connection', { error: e instanceof Error ? e.message : String(e) })
    return { ok: false, skipped: 'no active QuickBooks connection' }
  }
  // FAIL CLOSED: never let sandbox / a non-authoritative realm become CFO A/R truth.
  const gate = assertCfoProductionRealm(realmId, environment)
  logger.info(APP, 'ar_sync_realm', { realmId, environment, authoritative: gate.ok, reason: gate.reason })
  if (!gate.ok) return { ok: false, realmId, environment, skipped: `non-production realm rejected: ${gate.reason}` }

  const open = (await queryQBO<{ Invoice?: any[] }>("SELECT * FROM Invoice WHERE Balance > '0' ORDERBY TxnDate DESC MAXRESULTS 1000")).Invoice ?? []

  // Authoritative classification maps (never a name guess).
  const dealerRows = await db.execute(sql`select qb_customer_id, name from dealerships where qb_customer_id is not null`)
  const dealerByCustomerId = new Map<string, string>((dealerRows.rows as any[]).map((r) => [String(r.qb_customer_id), String(r.name)]))
  const estRows = await db.execute(sql`select id, qb_invoice_id from job_estimates where qb_invoice_id is not null`)
  const estimateIdByInvoiceId = new Map<string, string>((estRows.rows as any[]).map((r) => [String(r.qb_invoice_id), String(r.id)]))

  const capturedAt = new Date()
  const rows = open.map((inv) => {
    const qbInvoiceId = String(inv.Id)
    const cls = classifyReceivable({ qbInvoiceId, customerId: inv.CustomerRef?.value ? String(inv.CustomerRef.value) : null }, dealerByCustomerId, estimateIdByInvoiceId)
    const total = cents(inv.TotalAmt ?? 0), balance = cents(inv.Balance ?? 0)
    const { bucket, ageDays } = agingOf(inv.DueDate ?? inv.TxnDate ?? null, capturedAt)
    return {
      realmId, environment, qbInvoiceId, docNumber: inv.DocNumber ? String(inv.DocNumber) : null,
      customerId: inv.CustomerRef?.value ? String(inv.CustomerRef.value) : null, customerName: inv.CustomerRef?.name ?? null,
      txnDate: inv.TxnDate ?? null, dueDate: inv.DueDate ?? null, totalCents: total, balanceCents: balance,
      partial: balance > 0 && balance < total, classification: cls.classification, dealerName: cls.dealerName,
      linkedEstimateId: cls.linkedEstimateId, agingBucket: bucket, ageDays, capturedAt,
    }
  })
  if (rows.length) await db.insert(finArInvoices).values(rows)
  const totalCents = rows.reduce((t, r) => t + r.balanceCents, 0)
  logger.info(APP, 'ar_snapshot_persisted', { realmId, count: rows.length, totalCents })
  return { ok: true, captured: capturedAt.toISOString(), count: rows.length, totalCents, realmId, environment }
}

// ── Read model (production realm only) ────────────────────────────────────────
export interface ArInvoiceView {
  qbInvoiceId: string; docNumber: string | null; customerName: string | null; customerId: string | null
  txnDate: string | null; dueDate: string | null; totalCents: number; balanceCents: number; partial: boolean
  classification: 'dealer' | 'retail' | 'unknown'; dealerName: string | null; linkedEstimateId: string | null
  agingBucket: AgingBucket; ageDays: number
}
export interface ArSnapshot {
  asOf: string | null
  invoices: ArInvoiceView[]
  totalCents: number
  aging: Record<AgingBucket, number>
  dealerCents: number; retailCents: number; unknownCents: number
  byDealer: { dealer: string; cents: number; count: number }[]
  count: number
}

const EMPTY_AGING = (): Record<AgingBucket, number> => ({ current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 })

/** Latest A/R snapshot for the AUTHORITATIVE production realm only (sandbox rows are never returned). */
export async function getArSnapshot(): Promise<ArSnapshot> {
  const db = getDb()
  const [latest] = await db.select({ capturedAt: finArInvoices.capturedAt }).from(finArInvoices)
    .where(eq(finArInvoices.realmId, CFO_PRODUCTION_REALM)).orderBy(desc(finArInvoices.capturedAt)).limit(1)
  if (!latest) return { asOf: null, invoices: [], totalCents: 0, aging: EMPTY_AGING(), dealerCents: 0, retailCents: 0, unknownCents: 0, byDealer: [], count: 0 }
  const rows = await db.select().from(finArInvoices)
    .where(and(eq(finArInvoices.realmId, CFO_PRODUCTION_REALM), eq(finArInvoices.capturedAt, latest.capturedAt)))
  const invoices: ArInvoiceView[] = rows.map((r) => ({
    qbInvoiceId: r.qbInvoiceId, docNumber: r.docNumber, customerName: r.customerName, customerId: r.customerId,
    txnDate: r.txnDate, dueDate: r.dueDate, totalCents: r.totalCents, balanceCents: r.balanceCents, partial: r.partial,
    classification: r.classification as any, dealerName: r.dealerName, linkedEstimateId: r.linkedEstimateId,
    agingBucket: r.agingBucket as AgingBucket, ageDays: r.ageDays,
  }))
  const aging = EMPTY_AGING()
  let dealerCents = 0, retailCents = 0, unknownCents = 0
  const byDealerMap = new Map<string, { cents: number; count: number }>()
  for (const v of invoices) {
    aging[v.agingBucket] += v.balanceCents
    if (v.classification === 'dealer') { dealerCents += v.balanceCents; const k = v.dealerName ?? 'Dealer'; const cur = byDealerMap.get(k) ?? { cents: 0, count: 0 }; cur.cents += v.balanceCents; cur.count++; byDealerMap.set(k, cur) }
    else if (v.classification === 'retail') retailCents += v.balanceCents
    else unknownCents += v.balanceCents
  }
  return {
    asOf: latest.capturedAt.toISOString(), invoices, totalCents: invoices.reduce((t, v) => t + v.balanceCents, 0), aging,
    dealerCents, retailCents, unknownCents,
    byDealer: [...byDealerMap.entries()].map(([dealer, v]) => ({ dealer, cents: v.cents, count: v.count })).sort((a, b) => b.cents - a.cents),
    count: invoices.length,
  }
}
