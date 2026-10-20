/**
 * Record Payment / Email Paid Invoice orchestration — duplicate-proofing and state separation.
 *
 * Real Drizzle schema on an in-memory PGlite (real compare-and-set locks, real append-only events) with a
 * FAKE QuickBooks that models an invoice's Balance/LinkedTxn, Payment creation with QBO `requestid`
 * de-duplication, timeouts before/after the write, and the invoice send (DeliveryInfo). No network.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'
import { QBApiError } from './errors'
import type { QbPayment } from './retail-payment'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

const REALM = '9341457607058056'
let MAPPINGS: unknown = {}
vi.mock('@/apps/settings/db', () => ({ retailPaymentMappingsRaw: async () => MAPPINGS }))

// ── Fake QuickBooks ───────────────────────────────────────────────────────────
type Mode = 'ok' | 'reject' | 'timeout_before' | 'timeout_after' | 'server_error_after'
interface FakeInvoice { Id: string; DocNumber: string; TotalAmt: number; Balance: number; SyncToken: string; PrivateNote: string; EmailStatus: string; CustomerRef: { value: string }; BillEmail?: { Address: string }; LinkedTxn: Array<{ TxnId: string; TxnType: string }>; DeliveryInfo?: { DeliveryType: string; DeliveryTime: string } }
const QB = {
  invoice: null as unknown as FakeInvoice,
  payments: [] as QbPayment[],
  byRequestId: new Map<string, string>(),
  createMode: 'ok' as Mode,
  createCalls: 0,
  createArgs: [] as Array<Record<string, unknown>>,
  sendMode: 'ok' as Mode,
  sends: [] as string[],
  sendCalls: 0,
  verifyBlock: null as string | null,
  draftIncomplete: false,
  draftReference: null as number | null,
  draftTotal: 21218,
  /** Delayed visibility: payment id → reads of the invoice during which QuickBooks doesn't show it yet. */
  hidden: new Map<string, number>(),
  hideNextFor: 0,
  /** Runs after Record Payment's pre-checks, right before it takes its lock (an interleaving point). */
  beforeLock: null as null | (() => Promise<void>),
  /** Runs at the start of each payment create call (index = call number); may pause or throw. */
  onCreate: null as null | ((n: number) => Promise<void>),
  /** Runs inside each payment-list read (after the invoice snapshot was taken); may change local state. */
  onLoadPayments: null as null | (() => Promise<void>),
  /** Delivery metadata lag: a send's DeliveryInfo becomes visible only after this many invoice reads. */
  deliveryLagReads: 0,
  pendingDelivery: null as null | { time: string; reads: number },
  /** Runs at the start of each send call (index = call number); may pause or throw. */
  onSend: null as null | ((n: number) => Promise<void>),
  /** The un-waived card-payment charge on the draft (0 = none configured). Waived → the draft drops it. */
  cardFee: 0,
  /** Invoice Sync (card-fee removal): definite reject / ambiguous before or after QuickBooks applied it. */
  syncMode: 'ok' as Mode,
  syncCalls: 0,
  syncArgs: [] as Array<Record<string, unknown>>,
  /** Runs inside each Sync while it holds the Sync lock (index = call number). */
  onSync: null as null | ((n: number) => Promise<void>),
  /** Order of QuickBooks writes ('sync' / 'payment'). */
  writes: [] as string[],
}
/** The fake Invoice Draft total: the card charge drops out once waived (what the pricing engine does). */
const draftTotalFor = (waived: boolean) => (waived ? QB.draftTotal - QB.cardFee : QB.draftTotal)
const timeout = () => new DOMException('The operation timed out.', 'TimeoutError')
function applyPayment(amountCents: number, note: string, extra: Partial<QbPayment> = {}): QbPayment {
  const id = String(500 + QB.payments.length)
  const p: QbPayment = { Id: id, TotalAmt: amountCents / 100, PrivateNote: note, Line: [{ Amount: amountCents / 100, LinkedTxn: [{ TxnId: QB.invoice.Id, TxnType: 'Invoice' }] }], ...extra }
  QB.payments.push(p)
  if (QB.hideNextFor > 0) { QB.hidden.set(id, QB.hideNextFor); QB.hideNextFor = 0 }
  QB.invoice.Balance = Math.round(QB.invoice.Balance * 100 - amountCents) / 100
  QB.invoice.LinkedTxn.push({ TxnId: id, TxnType: 'Payment' })
  return p
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
/** What a read sees right now: hidden (not-yet-visible) payments are left out of the invoice's balance/links. */
function visibleInvoice(): FakeInvoice {
  if (QB.pendingDelivery && --QB.pendingDelivery.reads <= 0) { QB.invoice.DeliveryInfo = { DeliveryType: 'Email', DeliveryTime: QB.pendingDelivery.time }; QB.pendingDelivery = null }
  for (const [id, n] of QB.hidden) { if (n <= 1) QB.hidden.delete(id); else QB.hidden.set(id, n - 1) }
  const inv = clone(QB.invoice)
  for (const id of QB.hidden.keys()) {
    const p = QB.payments.find((x) => x.Id === id)!
    inv.Balance = Math.round(inv.Balance * 100 + Math.round((p.TotalAmt ?? 0) * 100)) / 100
    inv.LinkedTxn = inv.LinkedTxn.filter((l) => l.TxnId !== id)
  }
  return inv
}

vi.mock('@/apps/quickbooks/retail-payment-write', () => ({
  connectedRealmId: async () => REALM,
  verifyPaymentMapping: async () => { if (QB.beforeLock) { const h = QB.beforeLock; QB.beforeLock = null; await h() } return null },
  loadInvoicePayments: async ({ linkedIds, estimateId }: { linkedIds: string[]; estimateId: string }) => {
    if (QB.onLoadPayments) { const h = QB.onLoadPayments; QB.onLoadPayments = null; await h() }
    return clone(QB.payments.filter((p) => !QB.hidden.has(p.Id) && (linkedIds.includes(p.Id) || (p.PrivateNote ?? '').includes(`PSPAY:${estimateId}:`))))
  },
  createRetailPaymentInQB: async (args: { amountCents: number; privateNote: string; requestId: string; paymentMethodId: string; depositAccountId: string }) => {
    const n = QB.createCalls++; QB.createArgs.push(args); QB.writes.push('payment')
    if (QB.onCreate) await QB.onCreate(n)
    const prior = QB.byRequestId.get(args.requestId)
    if (prior) { const p = QB.payments.find((x) => x.Id === prior)!; return { paymentId: p.Id, totalCents: Math.round((p.TotalAmt ?? 0) * 100) } }
    if (QB.createMode === 'reject') throw new QBApiError(400, 'QuickBooks API /payment failed (400): validation')
    if (QB.createMode === 'timeout_before') { QB.createMode = 'ok'; throw timeout() }
    const p = applyPayment(args.amountCents, args.privateNote)
    QB.byRequestId.set(args.requestId, p.Id)
    if (QB.createMode === 'timeout_after') { QB.createMode = 'ok'; throw timeout() }
    if (QB.createMode === 'server_error_after') { QB.createMode = 'ok'; throw new QBApiError(503, 'unavailable') }
    return { paymentId: p.Id, totalCents: args.amountCents }
  },
}))
vi.mock('@/apps/quickbooks/retail-invoice-write', () => ({
  getRetailInvoiceRaw: async () => visibleInvoice(),
  fillRetailInvoiceEmail: async (_id: string, _t: string, email: string) => { QB.invoice.BillEmail = { Address: email } },
  sendRetailInvoiceInQB: async (_id: string, to: string) => {
    const n = QB.sendCalls++
    if (QB.onSend) await QB.onSend(n)
    if (QB.sendMode === 'reject') throw new QBApiError(400, 'QuickBooks API send failed (400): bad address')
    if (QB.sendMode === 'timeout_before') { QB.sendMode = 'ok'; throw timeout() }
    QB.sends.push(to)
    QB.invoice.EmailStatus = 'EmailSent'
    // QuickBooks reports DeliveryTime to the second.
    const time = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()
    if (QB.deliveryLagReads > 0) QB.pendingDelivery = { time, reads: QB.deliveryLagReads }
    else QB.invoice.DeliveryInfo = { DeliveryType: 'Email', DeliveryTime: time }
    if (QB.sendMode === 'timeout_after') { QB.sendMode = 'ok'; throw timeout() }
    return { invoiceId: QB.invoice.Id, invoiceNumber: QB.invoice.DocNumber, emailStatus: 'EmailSent', syncToken: '9', billEmail: to }
  },
}))
// The pricing engine's own math is covered for real in apps/workflow/estimate-card-fee-projection.test.ts;
// here the engine is a consistent fake: the stored total follows the REAL waive_card_fee column.
vi.mock('@/apps/workflow/estimate-db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/apps/workflow/estimate-db')>()
  const { jobEstimates: je } = await import('@/apps/workflow/schema')
  const { eq: eqq } = await import('drizzle-orm')
  return {
    ...real,
    projectEstimateTotalCents: async (_id: string, o: { waiveCardFee?: boolean }) => draftTotalFor(!!o.waiveCardFee),
    recomputeEstimate: async (id: string) => {
      const [row] = await holder.db!.select().from(je).where(eqq(je.id, id))
      await holder.db!.update(je).set({ totalCents: draftTotalFor(row.waiveCardFee) }).where(eqq(je.id, id))
    },
  }
})

// The full invoice-vs-draft verification is covered by the retail invoice tests; here it is the
// live fake invoice + a fake draft (the "current with the Invoice Draft" outcome is injected).
const DRAFT_TOTAL = 21218
vi.mock('@/apps/quickbooks/retail-invoice-service', async () => {
  const { getEstimateRow } = await import('@/apps/workflow/estimate-db')
  const { acquireRetailSyncLock: syncLock } = await import('./invoice-locks')
  const { jobEstimates: je } = await import('@/apps/workflow/schema')
  const { eq: eqq } = await import('drizzle-orm')
  return {
    flatPricingIssue: () => null,   // covered for real in retail-flat-price.test.ts
    verifyLinkedRetailInvoice: async (orderId: string, opts: { allowDrift?: boolean } = {}) => {
      const est = await getEstimateRow(orderId)
      if (QB.verifyBlock) return { ok: false, block: QB.verifyBlock, invoiceId: est?.qbInvoiceId, invoiceNumber: est?.qbInvoiceNumber }
      const raw = visibleInvoice()
      const waived = !!est!.waiveCardFee
      const draftTotal = draftTotalFor(waived)
      // The invoice must be current with the (possibly just-changed) draft — as the real verification does.
      if (!opts.allowDrift && /sync needed/i.test(est!.qbSyncError ?? '')) return { ok: false, block: 'sync_needed', invoiceId: est?.qbInvoiceId, invoiceNumber: est?.qbInvoiceNumber }
      if (!opts.allowDrift && Math.round(raw.TotalAmt * 100) !== draftTotal) return { ok: false, block: 'sync_needed', invoiceId: est?.qbInvoiceId, invoiceNumber: est?.qbInvoiceNumber }
      return {
        ok: true, est, raw, full: null,
        draft: { totalCents: draftTotal, paymentCharge: { cents: waived ? 0 : QB.cardFee, waived, label: 'Card Payment' }, pricingIncomplete: QB.draftIncomplete, referenceCents: QB.draftReference },
        contact: { name: 'Pat Sandbox', email: 'pat@example.com', phone: null },
        common: { invoiceId: est!.qbInvoiceId, invoiceNumber: est!.qbInvoiceNumber, syncToken: raw.SyncToken, qbTotalCents: Math.round(raw.TotalAmt * 100), draftTotalCents: draftTotal, emailStatus: raw.EmailStatus, alreadySent: raw.EmailStatus === 'EmailSent' },
      }
    },
    // Sync the SAME invoice to the current draft, through the REAL Sync lock (owner-fenced to the payment
    // attempt when called by Record Payment).
    syncRetailQBInvoice: async (p: { orderId: string; paymentLock?: { requestId: string; startedAt: Date } }) => {
      const n = QB.syncCalls++; QB.syncArgs.push(p as unknown as Record<string, unknown>)
      const est = (await getEstimateRow(p.orderId))!
      if (!(await syncLock(est.id, p.paymentLock))) return { ok: false, block: 'syncing', error: 'A sync is already in progress for this Job.' }
      const settle = (status: string, err: string | null) => holder.db!.update(je).set({ qbStatus: status, qbSyncError: err }).where(eqq(je.id, est.id))
      if (QB.onSync) await QB.onSync(n)
      const mode = QB.syncMode; QB.syncMode = 'ok'
      if (mode === 'reject') { await settle('error', 'validation'); return { ok: false, block: 'sync_failed', error: 'validation', ambiguous: false } }
      if (mode === 'timeout_before') { await settle('error', 'timed out'); return { ok: false, block: 'sync_failed', error: 'timed out', ambiguous: true } }
      const fresh = (await getEstimateRow(p.orderId))!
      const total = draftTotalFor(!!fresh.waiveCardFee)
      if (Math.round(QB.invoice.TotalAmt * 100) !== total) {
        const paid = Math.round(QB.invoice.TotalAmt * 100) - Math.round(QB.invoice.Balance * 100)
        QB.invoice.TotalAmt = total / 100
        QB.invoice.Balance = (total - paid) / 100
        QB.invoice.SyncToken = String(Number(QB.invoice.SyncToken) + 1)
        QB.writes.push('sync')
      }
      if (mode === 'timeout_after') { await settle('error', 'timed out'); return { ok: false, block: 'sync_failed', error: 'timed out', ambiguous: true } }
      await settle(fresh.qbStatus === 'syncing' ? 'created' : fresh.qbStatus, null)
      return { ok: true, draftTotalCents: total }
    },
  }
})

import { previewRetailPayment, recordRetailPayment, sendPaidRetailInvoice } from './retail-payment-service'
import { acquireRetailSyncLock } from './invoice-locks'
import { setEstimateWaiver } from '@/apps/workflow/estimate-db'
import { serviceOrders, vehicles, jobEstimates, serviceOrderEvents } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let orderId = ''
let estId = ''
const COMPLETED_AT = new Date('2026-10-18T15:30:00Z')

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})

beforeEach(async () => {
  for (const t of ['job_estimates', 'service_order_events', 'service_orders', 'vehicles']) await db.execute(`DELETE FROM ${t}`)
  const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Civic', year: '2019' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: 'PAY-1', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', customerName: 'Pat Sandbox', completedAt: COMPLETED_AT }).returning()
  orderId = o.id
  const [e] = await db.insert(jobEstimates).values({ serviceOrderId: o.id, qbInvoiceId: '900', qbInvoiceNumber: '1042', qbStatus: 'created' }).returning()
  estId = e.id
  QB.invoice = { Id: '900', DocNumber: '1042', TotalAmt: 212.18, Balance: 212.18, SyncToken: '0', PrivateNote: `PSID:${e.id}`, EmailStatus: 'NotSet', CustomerRef: { value: '58' }, BillEmail: { Address: 'pat@example.com' }, LinkedTxn: [] }
  QB.payments = []; QB.byRequestId = new Map(); QB.createMode = 'ok'; QB.createCalls = 0; QB.createArgs = []; QB.sendMode = 'ok'; QB.sends = []; QB.verifyBlock = null; QB.draftIncomplete = false; QB.draftReference = null
  QB.draftTotal = DRAFT_TOTAL; QB.hidden = new Map(); QB.hideNextFor = 0; QB.beforeLock = null; QB.onCreate = null
  QB.onLoadPayments = null; QB.deliveryLagReads = 0; QB.pendingDelivery = null; QB.onSend = null; QB.sendCalls = 0
  QB.cardFee = 0; QB.syncMode = 'ok'; QB.syncCalls = 0; QB.syncArgs = []; QB.onSync = null; QB.writes = []
  MAPPINGS = {
    realmId: REALM,
    cash: { paymentMethodId: '1', depositAccountId: '4' },
    check: { paymentMethodId: '2', depositAccountId: '4' },
    card_terminal: { paymentMethodId: '3', depositAccountId: '4' },
  }
})

const est = async () => (await db.select().from(jobEstimates).where(eq(jobEstimates.id, estId)))[0]
const events = async () => (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))).map((e) => e.eventType)
const record = (method: string, amount = DRAFT_TOTAL) => recordRetailPayment({ orderId, actor: 'Torlan', method, confirmedAmountCents: amount })

describe('Record Payment', () => {
  it('created invoice → counter cash payment → QuickBooks zero balance → Paid (cash)', async () => {
    const pv = await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(pv).toMatchObject({ ok: true, status: 'unpaid', amountCents: DRAFT_TOTAL, cardChargeCents: 0, methodAmounts: { cash: DRAFT_TOTAL, check: DRAFT_TOTAL, card_terminal: DRAFT_TOTAL } })
    expect(pv.methods?.every((m) => m.available)).toBe(true)
    const r = await record('cash')
    expect(r).toMatchObject({ ok: true, status: 'paid', method: 'cash', methodLabel: 'Cash', amountCents: DRAFT_TOTAL })
    expect(QB.invoice.Balance).toBe(0)
    expect(QB.payments).toHaveLength(1)
    expect(QB.createArgs[0]).toMatchObject({ paymentMethodId: '1', depositAccountId: '4', amountCents: DRAFT_TOTAL })
    const row = await est()
    expect(row).toMatchObject({ qbPaymentStatus: 'paid', qbPaymentMethod: 'cash', qbPaymentId: QB.payments[0].Id, qbPaidBy: 'Torlan', qbStatus: 'created', qbPaidEmailStatus: 'none' })
    expect(await events()).toEqual(expect.arrayContaining(['invoice_payment_attempt', 'invoice_payment_recorded']))
  })

  it('invoice already sent → later counter payment → Paid; the send state is untouched', async () => {
    await db.update(jobEstimates).set({ qbStatus: 'sent', qbSentAt: new Date() }).where(eq(jobEstimates.id, estId))
    QB.invoice.EmailStatus = 'EmailSent'
    expect(await record('card_terminal')).toMatchObject({ ok: true, status: 'paid', method: 'card_terminal' })
    expect(QB.createArgs[0]).toMatchObject({ paymentMethodId: '3' })
    expect(await est()).toMatchObject({ qbStatus: 'sent', qbPaymentStatus: 'paid' })
  })

  it('check maps to the check payment method', async () => {
    expect(await record('check')).toMatchObject({ status: 'paid', method: 'check', methodLabel: 'Check' })
    expect(QB.createArgs[0]).toMatchObject({ paymentMethodId: '2', depositAccountId: '4' })
  })

  it('already paid online → reconciled on open, NO second payment', async () => {
    applyPayment(DRAFT_TOTAL, 'Paid via QuickBooks Payments: Payment ID 281797', { TxnSource: 'EInvoice' })
    const pv = await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(pv).toMatchObject({ ok: true, status: 'paid', method: 'online', reconciled: true })
    const r = await record('cash')
    expect(r).toMatchObject({ ok: true, status: 'paid', method: 'online', alreadyPaid: true })
    expect(QB.createCalls).toBe(0)
    expect(QB.payments).toHaveLength(1)
    expect(await est()).toMatchObject({ qbPaymentStatus: 'paid', qbPaymentMethod: 'online' })
    expect(await events()).toContain('invoice_payment_reconciled')
  })

  it('double-submit (concurrent) → exactly one QuickBooks payment', async () => {
    const [a, b] = await Promise.all([record('cash'), record('cash')])
    expect(QB.payments).toHaveLength(1)
    expect([a.status, b.status]).toContain('paid')
    expect(QB.invoice.Balance).toBe(0)
    // A third tap after the fact is a no-op.
    expect(await record('cash')).toMatchObject({ status: 'paid' })
    expect(QB.payments).toHaveLength(1)
  })

  it('timeout AFTER QuickBooks created the payment → reconciled to Paid, no duplicate', async () => {
    QB.createMode = 'timeout_after'
    const r = await record('cash')
    expect(r).toMatchObject({ ok: true, status: 'paid', method: 'cash' })
    expect(QB.payments).toHaveLength(1)
    expect(await events()).toEqual(expect.arrayContaining(['invoice_payment_uncertain', 'invoice_payment_recorded']))
  })

  it('timeout BEFORE QuickBooks wrote → uncertain (not Paid); retry reuses the attempt id → one payment', async () => {
    QB.createMode = 'timeout_before'
    const r1 = await record('cash')
    expect(r1).toMatchObject({ ok: false, status: 'uncertain' })
    expect(await est()).toMatchObject({ qbPaymentStatus: 'uncertain' })
    const firstAttempt = (await est()).qbPaymentRequestId
    const r2 = await record('cash')
    expect(r2).toMatchObject({ ok: true, status: 'paid' })
    expect(QB.createArgs.map((a) => a.requestId)).toEqual([firstAttempt, firstAttempt])
    expect(QB.payments).toHaveLength(1)
  })

  it('5xx after QuickBooks wrote, then a retry → QuickBooks requestid returns the original; one payment', async () => {
    QB.createMode = 'server_error_after'
    // Make the in-call reconcile miss it (e.g. a read that also failed) by hiding the payment for one read.
    const saved = QB.invoice
    const r1 = await record('cash')
    expect(['paid', 'uncertain']).toContain(r1.status)
    QB.invoice = saved
    await record('cash')
    expect(QB.payments).toHaveLength(1)
    expect(QB.invoice.Balance).toBe(0)
  })

  it('definite QuickBooks rejection → error (nothing recorded), retry is a new attempt', async () => {
    QB.createMode = 'reject'
    expect(await record('cash')).toMatchObject({ ok: false, status: 'error' })
    expect(await est()).toMatchObject({ qbPaymentStatus: 'error' })
    QB.createMode = 'ok'
    expect(await record('cash')).toMatchObject({ ok: true, status: 'paid' })
    expect(new Set(QB.createArgs.map((a) => a.requestId)).size).toBe(2)
    expect(QB.payments).toHaveLength(1)
  })

  it('stale confirmation amount → refused with the current amount; nothing written', async () => {
    const r = await record('cash', 20000)
    expect(r).toMatchObject({ ok: false, block: 'amount_changed', amountCents: DRAFT_TOTAL })
    expect(QB.createCalls).toBe(0)
  })

  it('partially paid in QuickBooks → refused (no partial top-up here)', async () => {
    applyPayment(10000, 'manual')
    expect(await record('cash', 11218)).toMatchObject({ ok: false, block: 'partial_payment' })
    expect(QB.createCalls).toBe(0)
  })

  it('invoice not current with the Invoice Draft → refused before any QuickBooks write', async () => {
    QB.verifyBlock = 'sync_needed'
    expect(await record('cash')).toMatchObject({ ok: false, block: 'sync_needed' })
    expect(QB.createCalls).toBe(0)
  })

  it('Invoice Draft not settled (itemized ≠ agreed, or pricing incomplete) → refused even when QuickBooks matches', async () => {
    QB.draftReference = 12000
    expect(await record('cash')).toMatchObject({ ok: false, block: 'pricing_unresolved' })
    QB.draftReference = null; QB.draftIncomplete = true
    expect(await record('cash')).toMatchObject({ ok: false, block: 'pricing_unresolved' })
    expect(QB.createCalls).toBe(0)
  })

  it('unmapped method / mapping pinned to another company → refused', async () => {
    MAPPINGS = { realmId: REALM, cash: { paymentMethodId: '1', depositAccountId: '4' } }
    expect(await record('check')).toMatchObject({ ok: false, block: 'not_configured' })
    MAPPINGS = { realmId: '123146329198289', cash: { paymentMethodId: '1', depositAccountId: '4' } }
    expect(await record('cash')).toMatchObject({ ok: false, block: 'not_configured' })
    expect(await record('venmo')).toMatchObject({ ok: false, block: 'invalid_method' })
    expect(QB.createCalls).toBe(0)
  })

  it('never touches the job status or its original completion date', async () => {
    await record('cash')
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    expect(o.status).toBe('ready')
    expect(o.completedAt?.toISOString()).toBe(COMPLETED_AT.toISOString())
  })
})

describe('Email Paid Invoice', () => {
  it('refused until the payment is confirmed', async () => {
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })).toMatchObject({ ok: false, block: 'not_paid' })
    expect(QB.sends).toHaveLength(0)
  })

  it('emails the same invoice after payment even though the unpaid invoice was emailed before; repeat tap does not re-email', async () => {
    await db.update(jobEstimates).set({ qbStatus: 'sent', qbSentAt: new Date() }).where(eq(jobEstimates.id, estId))
    QB.invoice.EmailStatus = 'EmailSent'
    await record('cash')
    const r = await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })
    expect(r).toMatchObject({ ok: true, status: 'sent', recipient: 'pat@example.com' })
    expect(QB.sends).toEqual(['pat@example.com'])
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })).toMatchObject({ ok: true, alreadySent: true })
    expect(QB.sends).toHaveLength(1)
    // A deliberate resend is allowed.
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan', resend: true })).toMatchObject({ ok: true, status: 'sent' })
    expect(QB.sends).toHaveLength(2)
    expect(await est()).toMatchObject({ qbPaymentStatus: 'paid', qbPaidEmailStatus: 'sent', qbStatus: 'sent' })
  })

  it('email failure leaves the payment intact (still Paid)', async () => {
    await record('cash')
    QB.sendMode = 'reject'
    const r = await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })
    expect(r).toMatchObject({ ok: false, status: 'error' })
    expect(await est()).toMatchObject({ qbPaymentStatus: 'paid', qbPaidEmailStatus: 'error' })
    expect(QB.invoice.Balance).toBe(0)
    expect(await events()).toContain('invoice_paid_email_failed')
  })

  it('ambiguous send that QuickBooks actually delivered → reconciled as sent, no second email', async () => {
    await record('cash')
    QB.sendMode = 'timeout_after'
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })).toMatchObject({ ok: true, status: 'sent' })
    expect(QB.sends).toHaveLength(1)
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })).toMatchObject({ alreadySent: true })
    expect(QB.sends).toHaveLength(1)
  })

  it('QuickBooks no longer shows a zero balance → not emailed, flagged for review', async () => {
    await record('cash')
    QB.invoice.Balance = 212.18   // e.g. the payment was deleted in QuickBooks
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })).toMatchObject({ ok: false, block: 'not_paid' })
    expect(QB.sends).toHaveLength(0)
    expect(await est()).toMatchObject({ qbPaymentStatus: 'review' })
  })
})

describe('an unconfirmed payment keeps its identity until it is resolved', () => {
  it('uncertain Cash attempt, then Save as Check → refused; no new attempt, request id / method / amount preserved', async () => {
    QB.createMode = 'timeout_before'
    expect(await record('cash')).toMatchObject({ status: 'uncertain' })
    const before = await est()
    const r = await record('check')
    expect(r).toMatchObject({ ok: false, status: 'uncertain', block: 'attempt_unresolved', method: 'cash' })
    expect(QB.createCalls).toBe(1)
    expect(await est()).toMatchObject({ qbPaymentStatus: 'uncertain', qbPaymentRequestId: before.qbPaymentRequestId, qbPaymentMethod: 'cash', qbPaymentAmountCents: DRAFT_TOTAL })
  })

  it('delayed QuickBooks visibility: lost response, payment not visible yet, retry with a changed method → no second payment; the original surfaces as Paid', async () => {
    QB.createMode = 'timeout_after'
    QB.hideNextFor = 4   // QuickBooks created it, but reads don't show it for a while
    expect(await record('cash')).toMatchObject({ status: 'uncertain' })
    const attempt = (await est()).qbPaymentRequestId
    expect(await record('card_terminal')).toMatchObject({ ok: false, block: 'attempt_unresolved' })
    expect(await record('check')).toMatchObject({ ok: false, block: 'attempt_unresolved' })
    expect(QB.payments).toHaveLength(1)
    // The same method retries the SAME attempt; QuickBooks' requestid returns the original payment.
    const r = await record('cash')
    expect(QB.createArgs.every((a) => a.requestId === attempt)).toBe(true)
    expect(QB.payments).toHaveLength(1)
    // Once QuickBooks shows it, it is Paid — as Cash, the original method.
    const pv = r.status === 'paid' ? r : await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(pv).toMatchObject({ status: 'paid', method: 'cash' })
    expect(QB.invoice.Balance).toBe(0)
  })

  it('concurrent retries with different methods after an unconfirmed attempt → at most the original attempt is written', async () => {
    QB.createMode = 'timeout_before'
    await record('cash')
    const attempt = (await est()).qbPaymentRequestId
    await Promise.all([record('check'), record('cash'), record('card_terminal')])
    expect(new Set(QB.createArgs.map((a) => a.requestId))).toEqual(new Set([attempt]))
    expect(QB.createArgs.every((a) => a.paymentMethodId === '1')).toBe(true)
    expect(QB.payments).toHaveLength(1)
  })

  it('a stale "recording" lock (interrupted worker) is resumed with the same attempt and method only', async () => {
    QB.createMode = 'timeout_before'
    await record('cash')
    const attempt = (await est()).qbPaymentRequestId
    await db.update(jobEstimates).set({ qbPaymentStatus: 'recording', qbPaymentStartedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(jobEstimates.id, estId))
    expect(await record('check')).toMatchObject({ ok: false, block: 'attempt_unresolved' })
    expect(await record('cash')).toMatchObject({ status: 'paid', method: 'cash' })
    expect(QB.createArgs.map((a) => a.requestId)).toEqual([attempt, attempt])
  })

  it('preview reports the unresolved attempt so the sheet can lock its method', async () => {
    QB.createMode = 'timeout_before'
    await record('cash')
    const pv = await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(pv).toMatchObject({ status: 'uncertain', pendingMethod: 'cash', amountCents: DRAFT_TOTAL })
  })

  it('a DEFINITE rejection is resolved (nothing recorded) → a different method may start a new attempt', async () => {
    QB.createMode = 'reject'
    await record('cash')
    QB.createMode = 'ok'
    expect(await record('check')).toMatchObject({ status: 'paid', method: 'check' })
  })
})

describe('payment and invoice-changing operations exclude each other', () => {
  it('Sync first: while Sync holds the invoice, Record Payment is refused before any QuickBooks write', async () => {
    expect(await acquireRetailSyncLock(estId)).toBe(true)
    const r = await record('cash')
    expect(r).toMatchObject({ ok: false, block: 'invoice_busy' })
    expect(QB.createCalls).toBe(0)
    expect(await est()).toMatchObject({ qbPaymentStatus: 'none', qbStatus: 'syncing' })
  })

  it('Sync takes the invoice between Record Payment\'s checks and its lock → the payment lock fails; nothing written', async () => {
    QB.beforeLock = async () => { expect(await acquireRetailSyncLock(estId)).toBe(true) }
    const r = await record('cash')
    expect(r).toMatchObject({ ok: false, block: 'invoice_busy' })
    expect(QB.createCalls).toBe(0)
    expect(await est()).toMatchObject({ qbPaymentStatus: 'none' })
  })

  it('Payment first: while a payment is being recorded, Sync and fee changes cannot take the invoice', async () => {
    let syncGot: boolean | null = null, feeGot: boolean | null = null
    QB.onCreate = async () => {
      syncGot = await acquireRetailSyncLock(estId)
      feeGot = await setEstimateWaiver(estId, 'payment', true)
    }
    expect(await record('cash')).toMatchObject({ status: 'paid' })
    expect(syncGot).toBe(false)
    expect(feeGot).toBe(false)
    expect(await est()).toMatchObject({ qbStatus: 'created', waiveCardFee: false, qbPaymentStatus: 'paid' })
  })

  it('a fee change that lands between the payment checks and the lock → revalidated under the lock, nothing written', async () => {
    QB.beforeLock = async () => { expect(await setEstimateWaiver(estId, 'payment', true)).toBe(true); QB.draftTotal = DRAFT_TOTAL - 618 }
    const r = await record('cash')
    expect(r).toMatchObject({ ok: false })
    expect(QB.createCalls).toBe(0)
    expect(await est()).toMatchObject({ qbPaymentStatus: 'none' })
    // The lock was released: once the invoice is synced, the payment can be recorded.
    expect(await acquireRetailSyncLock(estId)).toBe(true)
  })

  it('once paid (or unconfirmed), fee changes are refused atomically', async () => {
    QB.createMode = 'timeout_before'
    await record('cash')
    expect(await setEstimateWaiver(estId, 'shop_supplies', true)).toBe(false)
    expect(await acquireRetailSyncLock(estId)).toBe(false)
  })

  it('a stale worker cannot overwrite a newer attempt\'s state', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    QB.onCreate = async (n) => {
      if (n !== 0) return
      // Worker A stalls past the stale-lock window; worker B takes over the SAME attempt and finishes.
      await db.update(jobEstimates).set({ qbPaymentStartedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(jobEstimates.id, estId))
      QB.onCreate = null
      const b = await record('cash')
      expect(b).toMatchObject({ status: 'paid' })
      release()
      await gate
      throw new QBApiError(400, 'late definite failure seen by the stale worker')
    }
    const a = await record('cash')
    // The superseded worker reports the CURRENT state (paid by the newer worker), not its own stale failure,
    // and audits nothing for a transition it did not make.
    expect(a).toMatchObject({ status: 'paid', alreadyPaid: true })
    expect(await events()).not.toContain('invoice_payment_failed')
    expect(await est()).toMatchObject({ qbPaymentStatus: 'paid', qbPaymentError: null })
    expect(QB.payments).toHaveLength(1)
  })
})

describe('stale "paid" snapshots never overwrite newer payment state', () => {
  const NEWER = 'Newer check: QuickBooks shows $212.18 due again — review in QuickBooks.'
  const establishReview = async () => {
    await db.update(jobEstimates).set({ qbPaymentStatus: 'review', qbPaymentError: NEWER }).where(eq(jobEstimates.id, estId))
  }

  it('reconciliation: an old paid snapshot resumes after a newer operation set review → review survives, no reconciled event', async () => {
    applyPayment(DRAFT_TOTAL, 'Paid via QuickBooks Payments: Payment ID 9', { TxnSource: 'EInvoice' })
    QB.onLoadPayments = establishReview   // the snapshot (invoice read) is already taken when this runs
    const r = await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(r.status).not.toBe('paid')
    expect(await est()).toMatchObject({ qbPaymentStatus: 'review', qbPaymentError: NEWER })
    expect(await events()).not.toContain('invoice_payment_reconciled')
    // A FRESH reconciliation (it observed the review state) may still legitimately adopt the payment.
    expect(await previewRetailPayment({ orderId, actor: 'Torlan' })).toMatchObject({ status: 'paid', method: 'online', reconciled: true })
    expect(await events()).toContain('invoice_payment_reconciled')
  })

  it('worker: an old worker holding a paid confirmation resumes after a newer operation set review → review survives, no recorded event', async () => {
    QB.onCreate = async () => { QB.onLoadPayments = establishReview }   // fires on the worker's post-write read
    const r = await record('cash')
    expect(r.status).not.toBe('paid')
    expect(await est()).toMatchObject({ qbPaymentStatus: 'review', qbPaymentError: NEWER })
    expect(await events()).not.toContain('invoice_payment_recorded')
    expect(QB.payments).toHaveLength(1)
  })
})

describe('Email Paid Invoice — no blind second send, no stale overwrite', () => {
  it('accepted send, lost response, delivery metadata delayed → a normal retry checks but does NOT send again; it confirms once QuickBooks shows it', async () => {
    await record('cash')
    QB.sendMode = 'timeout_after'; QB.deliveryLagReads = 3
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })).toMatchObject({ ok: false, status: 'uncertain' })
    const retry = await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })
    expect(retry).toMatchObject({ ok: false, status: 'uncertain', block: 'unconfirmed' })
    expect(QB.sends).toHaveLength(1)
    const later = await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })
    expect(later).toMatchObject({ ok: true, status: 'sent', alreadySent: true })
    expect(await est()).toMatchObject({ qbPaidEmailStatus: 'sent', qbPaidEmailTo: 'pat@example.com' })
    expect(QB.sends).toHaveLength(1)
    expect(await events()).toContain('invoice_paid_email_reconciled')
  })

  it('accepted send whose confirmation never appears → repeated normal retries never send; only an explicit resend sends another copy', async () => {
    await record('cash')
    QB.sendMode = 'timeout_after'; QB.deliveryLagReads = 1000
    await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })
    for (let i = 0; i < 3; i++) expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })).toMatchObject({ status: 'uncertain', block: 'unconfirmed' })
    expect(QB.sends).toHaveLength(1)
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan', resend: true })).toMatchObject({ ok: true, status: 'sent' })
    expect(QB.sends).toHaveLength(2)
    expect(await events()).toContain('invoice_paid_email_resent')
  })

  it('a recent UNPAID-invoice email is never mistaken for the paid-invoice email', async () => {
    QB.invoice.EmailStatus = 'EmailSent'
    QB.invoice.DeliveryInfo = { DeliveryType: 'Email', DeliveryTime: new Date(Math.floor(Date.now() / 1000) * 1000 - 2000).toISOString() }
    await record('cash')
    QB.sendMode = 'timeout_before'   // the paid send never reached QuickBooks
    const r = await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })
    expect(r.status).not.toBe('sent')
    expect(QB.sends).toHaveLength(0)
    expect(await est()).toMatchObject({ qbPaidEmailStatus: 'uncertain', qbPaymentStatus: 'paid' })
    expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })).toMatchObject({ status: 'uncertain', block: 'unconfirmed' })
  })

  it('a stale email worker cannot overwrite a newer attempt', async () => {
    await record('cash')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    QB.onSend = async (n) => {
      if (n !== 0) return
      await db.update(jobEstimates).set({ qbPaidEmailStartedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(jobEstimates.id, estId))
      QB.onSend = null
      expect(await sendPaidRetailInvoice({ orderId, actor: 'Torlan', resend: true })).toMatchObject({ ok: true, status: 'sent' })
      release(); await gate
      throw new QBApiError(400, 'late failure seen by the stale worker')
    }
    const a = await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })
    expect(a).toMatchObject({ status: 'sent', alreadySent: true })   // the newer attempt's state, not the stale failure
    expect(await events()).not.toContain('invoice_paid_email_failed')
    expect(await est()).toMatchObject({ qbPaidEmailStatus: 'sent', qbPaidEmailError: null, qbPaymentStatus: 'paid' })
    expect(QB.sends).toHaveLength(1)
  })

  it('email uncertainty never changes the payment', async () => {
    await record('cash')
    QB.sendMode = 'timeout_before'
    await sendPaidRetailInvoice({ orderId, actor: 'Torlan' })
    expect(await est()).toMatchObject({ qbPaymentStatus: 'paid', qbPaymentMethod: 'cash' })
    expect(QB.invoice.Balance).toBe(0)
  })
})

// ── Cash / Check: the card-payment charge is removed, the SAME invoice synced and verified, then paid ──
describe('Cash / Check remove the card-payment charge before paying', () => {
  const FEE = 618
  const CASH = DRAFT_TOTAL - FEE   // the pricing engine's total with the charge removed (fake engine above)
  beforeEach(() => { QB.cardFee = FEE })
  const paymentEvents = async () => (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId)))
    .filter((e) => e.eventType === 'invoice_override').map((e) => JSON.parse(e.note ?? '{}') as Record<string, unknown>)

  it('preview shows the Cash / Check amount before Save — and changes nothing', async () => {
    const pv = await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(pv).toMatchObject({ ok: true, amountCents: DRAFT_TOTAL, cardChargeCents: FEE, cardFeeRemovalCents: FEE, methodAmounts: { cash: CASH, check: CASH, card_terminal: DRAFT_TOTAL } })
    expect(await est()).toMatchObject({ waiveCardFee: false, qbPaymentStatus: 'none', qbPaymentCardFeeRemoved: false })
    expect(QB.invoice.TotalAmt).toBe(DRAFT_TOTAL / 100)
    expect(QB.syncCalls + QB.createCalls).toBe(0)
  })

  it('Cash: charge removed → same invoice synced → verified → paid the adjusted balance → Paid', async () => {
    const r = await record('cash', CASH)
    expect(r).toMatchObject({ ok: true, status: 'paid', method: 'cash', amountCents: CASH })
    expect(QB.writes).toEqual(['sync', 'payment'])                 // invoice updated BEFORE the payment
    expect(QB.invoice).toMatchObject({ Id: '900', TotalAmt: CASH / 100, Balance: 0 })
    expect(QB.payments).toHaveLength(1)
    expect(QB.createArgs[0]).toMatchObject({ amountCents: CASH, paymentMethodId: '1', depositAccountId: '4' })
    // Synced under THIS payment attempt's lock.
    const row = await est()
    expect(QB.syncArgs[0]).toMatchObject({ paymentLock: { requestId: row.qbPaymentRequestId } })
    expect(row).toMatchObject({ waiveCardFee: true, qbPaymentCardFeeRemoved: true, qbPaymentStatus: 'paid', qbPaymentAmountCents: CASH, totalCents: CASH, qbStatus: 'created', qbSyncError: null })
    expect(await paymentEvents()).toEqual([expect.objectContaining({ key: 'payment', action: 'removed', via: 'record_payment', method: 'cash' })])
    expect(await events()).toEqual(expect.arrayContaining(['invoice_payment_attempt', 'invoice_override', 'invoice_payment_recorded']))
  })

  it('Check: same removal, mapped to the check payment method', async () => {
    expect(await record('check', CASH)).toMatchObject({ ok: true, status: 'paid', method: 'check', amountCents: CASH })
    expect(QB.createArgs[0]).toMatchObject({ amountCents: CASH, paymentMethodId: '2' })
    expect(await est()).toMatchObject({ waiveCardFee: true, qbPaymentStatus: 'paid' })
  })

  it('Card Terminal keeps the card charge — no change, no sync', async () => {
    expect(await record('card_terminal', DRAFT_TOTAL)).toMatchObject({ ok: true, status: 'paid', method: 'card_terminal', amountCents: DRAFT_TOTAL })
    expect(QB.syncCalls).toBe(0)
    expect(QB.createArgs[0]).toMatchObject({ amountCents: DRAFT_TOTAL, paymentMethodId: '3' })
    expect(await est()).toMatchObject({ waiveCardFee: false, qbPaymentCardFeeRemoved: false })
  })

  it('Card Terminal keeps an intentional waiver too (pays the waived total, nothing re-added)', async () => {
    await setEstimateWaiver(estId, 'payment', true)
    QB.invoice.TotalAmt = CASH / 100; QB.invoice.Balance = CASH / 100
    expect(await record('card_terminal', CASH)).toMatchObject({ ok: true, status: 'paid', amountCents: CASH })
    expect(QB.syncCalls).toBe(0)
    expect(await est()).toMatchObject({ waiveCardFee: true })
  })

  it('charge already waived → Cash pays the current total; no second removal, no sync', async () => {
    await setEstimateWaiver(estId, 'payment', true)
    QB.invoice.TotalAmt = CASH / 100; QB.invoice.Balance = CASH / 100
    const pv = await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(pv).toMatchObject({ cardChargeCents: 0, cardFeeRemovalCents: 0, methodAmounts: { cash: CASH, card_terminal: CASH } })
    expect(await record('cash', CASH)).toMatchObject({ ok: true, status: 'paid', amountCents: CASH })
    expect(QB.syncCalls).toBe(0)
    expect(await paymentEvents()).toEqual([])
    expect(await est()).toMatchObject({ qbPaymentCardFeeRemoved: false })
  })

  it('confirming the card amount for Cash → refused with the Cash amount; nothing written', async () => {
    expect(await record('cash', DRAFT_TOTAL)).toMatchObject({ ok: false, block: 'amount_changed', amountCents: CASH })
    expect(QB.syncCalls + QB.createCalls).toBe(0)
    expect(await est()).toMatchObject({ waiveCardFee: false, qbPaymentStatus: 'none' })
  })

  it('already paid in QuickBooks → adopted; the charge is NOT removed and no payment is created', async () => {
    applyPayment(DRAFT_TOTAL, 'Paid via QuickBooks Payments', { TxnSource: 'EInvoice' })
    expect(await record('cash', CASH)).toMatchObject({ ok: true, status: 'paid', alreadyPaid: true, amountCents: DRAFT_TOTAL })
    expect(QB.syncCalls + QB.createCalls).toBe(0)
    expect(await est()).toMatchObject({ waiveCardFee: false, qbPaymentStatus: 'paid' })
  })

  it('paid in QuickBooks between the checks and the lock → adopted under the lock; charge untouched', async () => {
    QB.beforeLock = async () => { applyPayment(DRAFT_TOTAL, 'Paid via QuickBooks Payments', { TxnSource: 'EInvoice' }) }
    expect(await record('cash', CASH)).toMatchObject({ ok: true, status: 'paid', alreadyPaid: true })
    expect(QB.syncCalls + QB.createCalls).toBe(0)
    expect(await est()).toMatchObject({ waiveCardFee: false, qbPaymentStatus: 'paid' })
  })

  it('invoice update DEFINITELY rejected → nothing paid, the charge is put back; a retry starts clean and pays once', async () => {
    QB.syncMode = 'reject'
    const r = await record('cash', CASH)
    expect(r).toMatchObject({ ok: false, status: 'error', block: 'record_failed' })
    expect(QB.createCalls).toBe(0)
    expect(QB.invoice.TotalAmt).toBe(DRAFT_TOTAL / 100)
    expect(await est()).toMatchObject({ waiveCardFee: false, qbPaymentCardFeeRemoved: false, qbPaymentStatus: 'error', totalCents: DRAFT_TOTAL })
    expect((await paymentEvents()).map((e) => e.action)).toEqual(['removed', 'restored'])
    // Card Terminal is free to proceed at the full amount (the attempt was resolved: nothing happened).
    const pv = await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(pv).toMatchObject({ pendingMethod: null, methodAmounts: { cash: CASH, card_terminal: DRAFT_TOTAL } })
    expect(await record('cash', CASH)).toMatchObject({ ok: true, status: 'paid', amountCents: CASH })
    expect(QB.payments).toHaveLength(1)
  })

  it('invoice update response LOST after QuickBooks applied it → uncertain, pinned; a retry re-syncs (no-op) and pays exactly once', async () => {
    QB.syncMode = 'timeout_after'
    const r = await record('cash', CASH)
    expect(r).toMatchObject({ ok: false, status: 'uncertain', method: 'cash', amountCents: CASH })
    expect(QB.createCalls).toBe(0)
    const pinned = await est()
    expect(pinned).toMatchObject({ qbPaymentStatus: 'uncertain', qbPaymentMethod: 'cash', qbPaymentAmountCents: CASH, waiveCardFee: true, qbPaymentCardFeeRemoved: true })
    // A different method can't route around the pinned attempt (no re-adding the charge, no card payment).
    expect(await record('card_terminal', DRAFT_TOTAL)).toMatchObject({ block: 'attempt_unresolved', method: 'cash' })
    expect(await record('card_terminal', CASH)).toMatchObject({ block: 'attempt_unresolved', method: 'cash' })
    const pv = await previewRetailPayment({ orderId, actor: 'Torlan' })
    expect(pv).toMatchObject({ status: 'uncertain', pendingMethod: 'cash', cardFeeRemoved: true, methodAmounts: { cash: CASH } })
    // Retry as Cash: same attempt id; the sync finds QuickBooks already current; one payment.
    expect(await record('cash', CASH)).toMatchObject({ ok: true, status: 'paid', amountCents: CASH })
    expect(QB.createArgs.map((a) => a.requestId)).toEqual([pinned.qbPaymentRequestId])
    expect(QB.writes).toEqual(['sync', 'payment'])
    expect(QB.payments).toHaveLength(1)
  })

  it('invoice update timed out BEFORE QuickBooks applied it → uncertain; the retry syncs, verifies, then pays once', async () => {
    QB.syncMode = 'timeout_before'
    expect(await record('check', CASH)).toMatchObject({ status: 'uncertain', method: 'check' })
    expect(QB.invoice.TotalAmt).toBe(DRAFT_TOTAL / 100)
    // Never a payment against the unverified (still full) QuickBooks amount.
    expect(QB.createCalls).toBe(0)
    expect(await record('check', CASH)).toMatchObject({ ok: true, status: 'paid', amountCents: CASH })
    expect(QB.invoice).toMatchObject({ TotalAmt: CASH / 100, Balance: 0 })
    expect(QB.payments).toHaveLength(1)
  })

  it('payment response lost after the charge was removed and synced → retry: same attempt id, one payment', async () => {
    QB.createMode = 'timeout_before'
    expect(await record('cash', CASH)).toMatchObject({ status: 'uncertain' })
    expect(await est()).toMatchObject({ waiveCardFee: true, qbPaymentCardFeeRemoved: true, qbPaymentStatus: 'uncertain' })
    expect(await record('cash', CASH)).toMatchObject({ ok: true, status: 'paid', amountCents: CASH })
    expect(new Set(QB.createArgs.map((a) => a.requestId)).size).toBe(1)
    expect(QB.payments).toHaveLength(1)
  })

  it('double submission → one removal, one sync, one payment', async () => {
    const [a, b] = await Promise.all([record('cash', CASH), record('cash', CASH)])
    expect([a.status, b.status]).toContain('paid')
    expect(QB.payments).toHaveLength(1)
    expect(QB.writes.filter((w) => w === 'sync')).toHaveLength(1)
    expect((await paymentEvents()).filter((e) => e.action === 'removed')).toHaveLength(1)
  })

  it('while the fee removal holds the invoice, a manual Sync / fee change / second attempt cannot interleave', async () => {
    let manualSync: boolean | null = null, fee: boolean | null = null, second: unknown = null
    QB.onSync = async () => {
      manualSync = await acquireRetailSyncLock(estId)
      fee = await setEstimateWaiver(estId, 'payment', false)
      second = await record('card_terminal', DRAFT_TOTAL)
    }
    expect(await record('cash', CASH)).toMatchObject({ status: 'paid' })
    expect(manualSync).toBe(false)
    expect(fee).toBe(false)
    expect(second).toMatchObject({ ok: false, block: 'recording' })
    expect(QB.payments).toHaveLength(1)
  })

  it('a superseded worker cannot sync under a lock it no longer holds', async () => {
    QB.createMode = 'timeout_before'
    await record('cash', CASH)
    const row = await est()
    expect(await acquireRetailSyncLock(estId, { requestId: row.qbPaymentRequestId!, startedAt: row.qbPaymentStartedAt! })).toBe(false)   // uncertain, not recording
    expect(await acquireRetailSyncLock(estId, { requestId: 'someone-else', startedAt: new Date() })).toBe(false)
  })

  it('the amount changes after confirmation (another edit lands before the lock) → refused, nothing removed or paid', async () => {
    QB.beforeLock = async () => { QB.draftTotal = DRAFT_TOTAL + 1000; QB.invoice.TotalAmt = (DRAFT_TOTAL + 1000) / 100; QB.invoice.Balance = QB.invoice.TotalAmt }
    expect(await record('cash', CASH)).toMatchObject({ ok: false, block: 'amount_changed' })
    expect(QB.syncCalls + QB.createCalls).toBe(0)
    expect(await est()).toMatchObject({ waiveCardFee: false, qbPaymentStatus: 'none' })
    // Re-confirming the new Cash amount succeeds.
    expect(await record('cash', DRAFT_TOTAL + 1000 - FEE)).toMatchObject({ ok: true, status: 'paid', amountCents: DRAFT_TOTAL + 1000 - FEE })
  })

  it('never touches the job status or its original completion date', async () => {
    await record('cash', CASH)
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    expect(o.status).toBe('ready')
    expect(o.completedAt?.toISOString()).toBe(COMPLETED_AT.toISOString())
  })
})
