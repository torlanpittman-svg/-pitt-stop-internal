/**
 * REAL Postgres (PGlite) tests for persisted cross-source matches and the owner reconciliation model.
 * The schema is pushed from the real drizzle definitions (app + finance), then migration 0079 is applied so
 * the partial unique indexes that make a confirmed match exclusive are the production ones.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as base from '@/drizzle/schema'
import * as fin from './schema'

const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/platform/db', () => ({ getDb: () => h.db }))

import { decideLink, clearLink, liveLinks } from './purchase-links'
import { getOwnerReconciliation } from './reconcile-links'
import { confirmReceiptMatch } from './receipts-cfo'
import { getReconciliation } from '@/apps/expenses/reconcile'
import { allocateReceipt, listJobExpenses } from '@/apps/expenses/job-expenses'
import { monthlyExpenseReport } from '@/apps/expenses/db'

const schema = { ...base, ...fin }
let client: PGlite
let db: ReturnType<typeof drizzle<typeof schema>>
const TODAY = '2026-11-13'
const owner = () => getOwnerReconciliation({ today: TODAY, days: 60 })
let seq = 0
async function receipt(over: Partial<typeof base.businessReceipts.$inferInsert> = {}) {
  seq++
  const [r] = await db.insert(base.businessReceipts).values({
    status: 'filed', entity: 'detail', category: 'parts', vendor: 'Tesla Inc.', receiptDate: '2026-11-13', totalCents: 8021, paymentMethod: 'card', paymentLast4: '0320', accountRef: '*2649',
    funding: 'business', storage: 'none', imageHash: `h${seq}`, aiStatus: 'extracted', qbSyncStatus: 'export_ready', invoiceNumber: null, ...over,
  }).returning()
  return r.id
}
let item: string
async function txn(name: string, cents: number, date: string, cls = 'expense', over: Partial<typeof fin.finTransactions.$inferInsert> = {}) {
  seq++
  const [t] = await db.insert(fin.finTransactions).values({ plaidItemId: item, plaidAccountId: 'acct', plaidTransactionId: `p${seq}`, amountCents: cents, direction: 'out', txnDate: date, name, txnClass: cls, isExpense: cls === 'expense' || cls === 'inventory' || cls === 'check', ...over }).returning()
  return t.id
}
async function qbPurchase(id: string, cents: number, date: string, payee: string, over: Partial<typeof fin.finQbPurchases.$inferInsert> = {}) {
  await db.insert(fin.finQbPurchases).values({ qbKey: `Purchase:${id}`, qbType: 'Purchase', qbId: id, totalCents: cents, txnDate: date, payeeName: payee, paymentType: 'CreditCard', ...over })
  return `Purchase:${id}`
}

beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  const { apply } = await pushSchema(schema as never, db as never)
  await apply()
  const sqlText = readFileSync(fileURLToPath(new URL('../../drizzle/migrations/manual/0079_purchase_links.sql', import.meta.url)), 'utf8')
  for (const stmt of sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)) await client.query(stmt)
  h.db = db
}, 120_000)
beforeEach(async () => {
  await client.exec(`TRUNCATE purchase_links, fin_receipt_matches, fin_events, fin_qb_purchases, fin_transactions, fin_obligations, fin_plaid_items, expense_allocations, business_receipts, checks, vehicle_financial_events, inventory_vehicles, service_orders, vehicles CASCADE;`)
  const [i] = await db.insert(fin.finPlaidItems).values({ itemId: `it${++seq}`, environment: 'sandbox', accessTokenEnc: 'x' } as never).returning()
  item = i.id
})
afterAll(async () => { await client.close() })

describe('confirmed matches are persisted, exclusive and audited', () => {
  it('a suggestion is confirmed once, survives a reload, and is not suggested again', async () => {
    const r = await receipt({ invoiceNumber: 'INV-77' })
    const q = await qbPurchase('501', 8021, '2026-11-14', 'Tesla', { privateNote: 'INV-77 seat foam' })
    const before = await owner()
    const s = before.suggestions.find((x) => x.kind === 'receipt_qb')!
    expect(s).toMatchObject({ strength: 'strong', ambiguous: false })
    expect(s.a.id).toBe(r); expect(s.b.id).toBe(q)
    expect(before.confirmed).toHaveLength(0)                       // nothing is matched until a person confirms

    expect((await decideLink({ kind: 'receipt_qb', aId: r, bId: q, status: 'confirmed', actor: 'admin', evidence: s.evidence })).ok).toBe(true)
    const after = await owner()                                    // a fresh load reads the SAVED decision
    expect(after.suggestions.filter((x) => x.kind === 'receipt_qb')).toHaveLength(0)
    expect(after.confirmed).toHaveLength(1)
    expect(after.confirmed[0]).toMatchObject({ kind: 'receipt_qb', decidedBy: 'admin' })
    // idempotent
    expect(await decideLink({ kind: 'receipt_qb', aId: r, bId: q, status: 'confirmed', actor: 'admin' })).toMatchObject({ ok: true, already: true })
    expect((await liveLinks()).length).toBe(1)
    const ev = await db.select().from(fin.finEvents)
    expect(ev.map((e) => e.action)).toEqual(['confirm'])
  })
  it('a record already confirmed to one partner cannot be confirmed to another', async () => {
    const r1 = await receipt(), r2 = await receipt()
    const q = await qbPurchase('502', 8021, '2026-11-13', 'Tesla')
    await decideLink({ kind: 'receipt_qb', aId: r1, bId: q, status: 'confirmed', actor: 'admin' })
    const second = await decideLink({ kind: 'receipt_qb', aId: r2, bId: q, status: 'confirmed', actor: 'admin' })
    expect(second.ok).toBe(false)
    expect(second.error).toContain('already matched')
    expect((await liveLinks()).filter((l) => l.status === 'confirmed')).toHaveLength(1)
  })
  it('"not the same" is remembered; undo keeps history and brings the suggestion back', async () => {
    const r = await receipt(); const q = await qbPurchase('503', 8021, '2026-11-13', 'Tesla Inc')
    const d = await decideLink({ kind: 'receipt_qb', aId: r, bId: q, status: 'dismissed', actor: 'admin' })
    expect((await owner()).suggestions.filter((x) => x.kind === 'receipt_qb')).toHaveLength(0)
    expect((await clearLink(d.id!, 'admin')).ok).toBe(true)
    expect((await owner()).suggestions.filter((x) => x.kind === 'receipt_qb')).toHaveLength(1)
    const rows = await db.select().from(fin.purchaseLinks)
    expect(rows).toHaveLength(1)                                    // never deleted
    expect(rows[0]).toMatchObject({ status: 'cleared', clearedBy: 'admin' })
    expect((await db.select().from(fin.finEvents)).map((e) => e.action)).toEqual(['dismiss', 'clear'])
  })
  it('refuses a pending bank payment, a rejected receipt and an unknown QuickBooks entry', async () => {
    const r = await receipt(); const bad = await receipt({ status: 'rejected' })
    const q = await qbPurchase('504', 8021, '2026-11-13', 'Tesla')
    const pending = await txn('CHECK 10390', 7500, '2026-11-12', 'check', { pending: true })
    const [c] = await db.insert(base.checks).values({ checkNumber: 10390, bankKey: 'operating', bankQboAccountId: '31', payeeName: 'PDR', amountCents: 7500, category: 'customer_job', expenseQboAccountId: '16', actorKey: 'torlan', actorName: 'Torlan', checkDate: '2026-11-12', qbStatus: 'recorded', idempotencyKey: 'k1' } as never).returning()
    expect((await decideLink({ kind: 'check_txn', aId: c.id, bId: pending, status: 'confirmed', actor: 'admin' })).error).toContain('pending')
    expect((await decideLink({ kind: 'receipt_qb', aId: bad, bId: q, status: 'confirmed', actor: 'admin' })).ok).toBe(false)
    expect((await decideLink({ kind: 'receipt_qb', aId: r, bId: 'Purchase:nope', status: 'confirmed', actor: 'admin' })).ok).toBe(false)
  })
})

describe('one purchase counts once across every connected source', () => {
  it('receipt + bank + QuickBooks for one purchase: three records, counted once after matching', async () => {
    const r = await receipt()
    const t = await txn('TESLA INC', 8021, '2026-11-12')
    const q = await qbPurchase('601', 8021, '2026-11-12', 'Tesla')
    const before = (await owner()).ledger
    expect(before.countedOnceCents).toBe(8021 * 3)                 // honest: unmatched records are separate
    expect(before.singleSourceCount).toBe(3)
    expect((await confirmReceiptMatch(r, t, 'admin')).ok).toBe(true)
    await decideLink({ kind: 'txn_qb', aId: t, bId: q, status: 'confirmed', actor: 'admin' })
    const after = (await owner()).ledger
    expect(after.countedOnceCents).toBe(8021)
    expect(after).toMatchObject({ naiveSumCents: 8021 * 3, duplicateCents: 8021 * 2, multiSourceCount: 1, singleSourceCount: 0 })
  })
  it('a receipt and the inventory-vehicle ledger line for the same purchase do not inflate the total', async () => {
    const [v] = await db.insert(base.vehicles).values({ year: '2019', make: 'Ford', model: 'F-150', vin: '1FTTESTVIN0000002' }).returning()
    const [iv] = await db.insert(base.inventoryVehicles).values({ vehicleId: v.id, stockNumber: 'PS-0002' } as never).returning()
    const r = await receipt({ vendor: 'NAPA', totalCents: 5310, inventoryVehicleId: iv.id, entity: 'auto_sales', receiptDate: '2026-11-08' })
    const [e] = await db.insert(base.vehicleFinancialEvents).values({ inventoryVehicleId: iv.id, economicCategory: 'part', cashflowCategory: 'operating', amountCents: 5310, eventDate: '2026-11-08', vendor: 'NAPA Auto Parts', status: 'verified', source: 'receipt_ai' } as never).returning()
    const before = await owner()
    expect(before.ledger.countedOnceCents).toBe(10620)
    const s = before.suggestions.find((x) => x.kind === 'receipt_vehicle_event')!
    expect(s.b.id).toBe(e.id)
    // the manager-side queue flags it too, and stops once decided
    expect((await getReconciliation({ today: TODAY, includeBank: true })).queues.find((q) => q.key === 'duplicates')!.count).toBe(1)
    await decideLink({ kind: 'receipt_vehicle_event', aId: r, bId: e.id, status: 'confirmed', actor: 'admin' })
    expect((await owner()).ledger.countedOnceCents).toBe(5310)
    expect((await getReconciliation({ today: TODAY, includeBank: true })).queues.find((q) => q.key === 'duplicates')!.count).toBe(0)
    // each list's own history is untouched
    expect((await db.select().from(base.vehicleFinancialEvents))).toHaveLength(1)
    expect((await monthlyExpenseReport('2026-11')).purchasesTotalCents).toBe(5310)
  })
  it('a written check is the same purchase as the QuickBooks entry it created — with no manual match', async () => {
    await db.insert(base.checks).values({ checkNumber: 10390, bankKey: 'operating', bankQboAccountId: '31', payeeName: 'PDR', amountCents: 7500, category: 'customer_job', expenseQboAccountId: '16', actorKey: 'torlan', actorName: 'Torlan', checkDate: '2026-11-12', qbStatus: 'recorded', qboTxnId: '24657', idempotencyKey: 'k2' } as never)
    await qbPurchase('24657', 7500, '2026-11-12', 'PDR', { paymentType: 'Check', docNumber: '10390' })
    const cleared = await txn('CHECK 10390', 7500, '2026-11-13', 'check')
    const o = await owner()
    expect(o.ledger.countedOnceCents).toBe(15000)                  // check+QuickBooks = one; the bank line still unmatched
    const s = o.suggestions.find((x) => x.kind === 'check_txn')!
    expect(s).toMatchObject({ strength: 'strong' }); expect(s.b.id).toBe(cleared)
    expect(o.suggestions.filter((x) => x.kind === 'txn_qb')).toHaveLength(0) // not offered twice through QuickBooks
    await decideLink({ kind: 'check_txn', aId: s.a.id, bId: cleared, status: 'confirmed', actor: 'admin' })
    expect((await owner()).ledger.countedOnceCents).toBe(7500)
  })
  it('card payments, transfers, payroll, loan payments and owner draws are never counted as purchases', async () => {
    await txn('SHELL OIL', 4411, '2026-11-12')
    await txn('AMEX EPAYMENT', 180000, '2026-11-05', 'card_payment')
    await txn('TRANSFER TO SAVINGS', 50000, '2026-11-06', 'transfer')
    await txn('CHECK 10361', 157245, '2026-11-07', 'payroll')
    await txn('FLOOR PLAN PMT', 90000, '2026-11-08', 'debt_payment')
    await txn('TO CHECKING 0169', 100000, '2026-11-09', 'owner_draw')
    const o = await owner()
    expect(o.ledger.countedOnceCents).toBe(4411)
    expect(o.cashMovements.map((m) => m.txnClass).sort()).toEqual(['card_payment', 'debt_payment', 'owner_draw', 'payroll', 'transfer'])
    expect(o.cashMovements.reduce((s, m) => s + m.cents, 0)).toBe(577245)
  })
  it('a job allocation is separate from expense recognition: it changes no purchase total', async () => {
    const [v] = await db.insert(base.vehicles).values({ year: '2026', make: 'Tesla', model: 'Model Y', vin: '5YJTESTVIN0000001' }).returning()
    const [o] = await db.insert(base.serviceOrders).values({ orderNumber: 'SO-20261113-0001', vehicleId: v.id, customerName: 'Pat Sample' }).returning()
    const r = await receipt()
    const before = (await owner()).ledger.countedOnceCents
    await allocateReceipt({ receiptId: r, target: 'job', serviceOrderId: o.id, amountCents: null }, { name: 'Torlan', key: 'torlan' })
    expect((await listJobExpenses(o.id)).recordedCents).toBe(8021)
    expect((await owner()).ledger.countedOnceCents).toBe(before)
    expect(before).toBe(8021)
  })
})

describe('expected bills and their actual payments are matched, never added', () => {
  it('forecast → suggested payment → confirmed: the payment is the actual, counted once', async () => {
    const [ob] = await db.insert(fin.finObligations).values({ vendor: 'Wellborn Properties', category: 'rent', amountCents: 250000, frequency: 'monthly', status: 'confirmed' }).returning()
    await db.insert(fin.finObligations).values({ vendor: 'Atmos Energy', category: 'utilities', amountCents: 12000, frequency: 'monthly', status: 'confirmed' })
    const pay = await txn('ACH WELLBORN PROPERTIES', 250000, '2026-11-03')
    await txn('SHELL OIL', 4411, '2026-11-12')
    const before = await owner()
    const rent = before.bills.find((b) => b.vendor === 'Wellborn Properties')!
    expect(rent.state).toBe('payment_suggested'); expect(rent.payment?.id).toBe(pay)
    expect(before.bills.find((b) => b.vendor === 'Atmos Energy')!.state).toBe('not_seen')
    expect(before.billsPaidConfirmedCents).toBe(0)
    const total = before.ledger.countedOnceCents
    expect(total).toBe(254411)                                     // the rent PAYMENT is a purchase; the forecast is not a node

    await decideLink({ kind: 'bill_payment', aId: ob.id, bId: pay, status: 'confirmed', actor: 'admin', amountCents: 250000 })
    const after = await owner()
    expect(after.bills.find((b) => b.vendor === 'Wellborn Properties')!.state).toBe('paid_confirmed')
    expect(after.billsPaidConfirmedCents).toBe(250000)
    expect(after.billsExpectedCents).toBe(262000)                  // forecast stays a forecast
    expect(after.ledger.countedOnceCents).toBe(total)              // matching a bill adds NOTHING to actuals
    // the review queue no longer lists the paid bill, and the payment is no longer "no receipt"
    const q = await getReconciliation({ today: TODAY, includeBank: true })
    expect(q.queues.find((x) => x.key === 'bill_no_payment')!.items.map((i) => i.title)).toEqual(['Atmos Energy'])
    expect(q.queues.find((x) => x.key === 'txn_no_receipt')!.items.map((i) => i.title)).toEqual(['SHELL OIL'])
  })
  it('one bank payment cannot pay two bills; the same bill can be paid again next period', async () => {
    const [a] = await db.insert(fin.finObligations).values({ vendor: 'Wellborn Properties', amountCents: 250000, frequency: 'monthly', status: 'confirmed' }).returning()
    const [b] = await db.insert(fin.finObligations).values({ vendor: 'Wellborn Storage', amountCents: 250000, frequency: 'monthly', status: 'confirmed' }).returning()
    const oct = await txn('ACH WELLBORN PROPERTIES', 250000, '2026-10-03'), nov = await txn('ACH WELLBORN PROPERTIES', 250000, '2026-11-03')
    expect((await decideLink({ kind: 'bill_payment', aId: a.id, bId: oct, status: 'confirmed', actor: 'admin' })).ok).toBe(true)
    expect((await decideLink({ kind: 'bill_payment', aId: a.id, bId: nov, status: 'confirmed', actor: 'admin' })).ok).toBe(true)
    expect((await decideLink({ kind: 'bill_payment', aId: b.id, bId: nov, status: 'confirmed', actor: 'admin' })).ok).toBe(false)
  })
  it('a bank feed that stops before today reports "not yet observable", not "unpaid"', async () => {
    await db.insert(fin.finObligations).values({ vendor: 'Atmos Energy', amountCents: 12000, frequency: 'monthly', status: 'confirmed' })
    await txn('SHELL OIL', 4411, '2026-11-01')                     // feed ends 12 days ago
    const o = await owner()
    expect(o.bills[0].state).toBe('not_observable')
    expect(o.coverage.find((c) => c.key === 'bank')).toMatchObject({ state: 'stale' })
    expect(o.coverage.find((c) => c.key === 'qb')).toMatchObject({ state: 'unavailable' })   // nothing mirrored yet → says so
  })
})
