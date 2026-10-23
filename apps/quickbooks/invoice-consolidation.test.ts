/**
 * Combine unpaid invoices — end to end on an in-memory PGlite (real schema, real partial unique indexes, real
 * data-modifying CTE claims) with the REAL pricing engine, Invoice Draft, Create / Sync / Send / shared-invoice
 * services. Only the QuickBooks HTTP layer is a fake in-memory company with SyncToken compare-and-set on update AND
 * void. Nothing is ever emailed: the fake's send throws.
 *
 * Scenario: Kelvin Cooper's two vehicles were each completed and invoiced separately; a manager combines them.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq, sql } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

/* eslint-disable @typescript-eslint/no-explicit-any */
const qb = vi.hoisted(() => ({
  invoices: new Map<string, any>(),
  nextId: 500,
  customers: new Map<string, string>(),
  calls: { create: 0, update: 0, send: 0, list: 0, raw: 0, void: 0 },
  failRaw: 0,
  beforeVoid: null as null | (() => Promise<void>),
  afterVoid: null as null | (() => Promise<void>),
  voidMode: 'ok' as 'ok' | 'lost_response' | 'timeout_not_applied' | 'refuse' | 'marker_only',
  realm: 'sandbox-realm' as string | null,
  beforeUpdate: null as null | (() => Promise<void>),
  afterUpdate: null as null | (() => Promise<void>),
}))
const clone = <T>(x: T): T => (x == null ? x : JSON.parse(JSON.stringify(x)))
vi.mock('@/apps/quickbooks/retail-invoice-write', async (orig) => {
  const real = await orig<typeof import('./retail-invoice-write')>()
  const plan = await import('./shared-invoice-plan')
  const { QBApiError } = await import('./errors')
  const toRaw = (lines: any[]) => lines.map((l) => (l.kind === 'text'
    ? { DetailType: 'DescriptionOnly', Description: l.description, DescriptionLineDetail: {} }
    : { DetailType: 'SalesItemLineDetail', Amount: l.amountCents / 100, Description: l.description, SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: 1, UnitPrice: l.amountCents / 100 } }))
  const sum = (lines: any[]) => lines.filter((l) => l.kind !== 'text').reduce((t: number, l: any) => t + l.amountCents, 0) / 100
  const summarize = (inv: any) => ({ invoiceId: inv.Id, invoiceNumber: inv.DocNumber, syncToken: inv.SyncToken, totalAmtCents: Math.round(inv.TotalAmt * 100), lineCount: inv.Line.filter((l: any) => l.DetailType === 'SalesItemLineDetail').length, linesFingerprint: plan.linesFingerprint(plan.linesFromRawInvoice(inv.Line)) })
  const bump = (inv: any) => { inv.SyncToken = String(Number(inv.SyncToken) + 1) }
  return {
    ...real,
    resolveRetailItems: async () => ({ labor: 'LABOR', fees: 'FEES' }),
    createRetailInvoiceInQB: async (p: any) => {
      qb.calls.create++
      const id = String(qb.nextId++)
      const inv = { Id: id, DocNumber: `10${id}`, SyncToken: '0', TotalAmt: sum(p.lines), Balance: sum(p.lines), EmailStatus: 'NotSet', CustomerRef: { value: p.customerId }, PrivateNote: p.privateNote, CustomerMemo: { value: p.customerMemo }, BillEmail: p.billEmail ? { Address: p.billEmail } : undefined, Line: toRaw(p.lines), TxnDate: `2026-10-${10 + Number(id) - 500}` }
      qb.invoices.set(id, inv)
      return summarize(inv)
    },
    updateRetailInvoiceInQB: async (p: any) => {
      if (qb.beforeUpdate) { const h = qb.beforeUpdate; qb.beforeUpdate = null; await h() }
      qb.calls.update++
      const inv = qb.invoices.get(p.current.Id)
      if (String(p.current.SyncToken) !== String(inv.SyncToken)) throw new QBApiError(400, 'Stale Object Error')
      Object.assign(inv, { Line: toRaw(p.lines), PrivateNote: p.privateNote, CustomerMemo: { value: p.customerMemo }, TotalAmt: sum(p.lines), Balance: sum(p.lines) }); bump(inv)
      if (qb.afterUpdate) { const h = qb.afterUpdate; qb.afterUpdate = null; await h() }
      return summarize(inv)
    },
    voidRetailInvoiceInQB: async (id: string, token: string) => {
      if (qb.beforeVoid) { const h = qb.beforeVoid; qb.beforeVoid = null; await h() }
      qb.calls.void++
      const inv = qb.invoices.get(String(id))
      if (qb.voidMode === 'refuse') throw new QBApiError(400, 'Business Validation Error')
      if (qb.voidMode === 'timeout_not_applied') throw new Error('ETIMEDOUT')
      if (String(token) !== String(inv.SyncToken)) throw new QBApiError(400, 'Stale Object Error: You and someone else were editing the same transaction')
      // A response that can't be trusted: the "Voided" marker without the zeroed amounts.
      if (qb.voidMode === 'marker_only') { Object.assign(inv, { PrivateNote: `Voided - ${inv.PrivateNote}` }); bump(inv); return clone(inv) }
      // QuickBooks void, as observed on production #100897 (voided by Pitt Stop 2026-10-05): keeps the transaction,
      // its DocNumber and customer, zeroes amounts, and REPLACES PrivateNote with "Voided" (the PSID is gone).
      Object.assign(inv, { TotalAmt: 0, Balance: 0, PrivateNote: 'Voided', Line: inv.Line.map((l: any) => (l.DetailType === 'SalesItemLineDetail' ? { ...l, Amount: 0, SalesItemLineDetail: { ...l.SalesItemLineDetail, UnitPrice: 0 } } : l)) }); bump(inv)
      if (qb.afterVoid) { const h = qb.afterVoid; qb.afterVoid = null; await h() }
      if (qb.voidMode === 'lost_response') throw new Error('socket hang up')
      return clone(inv)
    },
    getRetailInvoiceRaw: async (id: string) => {
      qb.calls.raw++
      if (qb.failRaw > 0) { qb.failRaw--; throw new Error('QuickBooks is unavailable') }
      return clone(qb.invoices.get(String(id)) ?? null)
    },
    listRetailInvoicesForCustomer: async (cid: string) => { qb.calls.list++; return [...qb.invoices.values()].filter((i) => i.CustomerRef.value === cid).map(clone) },
    findRetailInvoiceByPsid: async (cid: string, estId: string) => {
      const inv = [...qb.invoices.values()].find((i) => i.CustomerRef.value === cid && String(i.PrivateNote ?? '').includes(`PSID:${estId}`) && !real.isVoidedInvoice(i))
      return inv ? summarize(inv) : null
    },
    sendRetailInvoiceInQB: async () => { qb.calls.send++; throw new Error('TEST: an invoice must never be emailed') },
    fillRetailInvoiceEmail: async () => { throw new Error('TEST: no email fill expected') },
  }
})
vi.mock('@/apps/quickbooks/retail-item-map', () => ({
  loadRetailItemIndex: async () => {
    const none = { itemRef: null, itemName: 'Labor', usable: false, description: null }
    return { match: () => none, matchService: () => none, partsItem: () => null }
  },
}))
vi.mock('@/apps/quickbooks/retail-payment-write', async (orig) => ({
  ...(await orig<typeof import('./retail-payment-write')>()),
  connectedRealmId: async () => qb.realm,
  getQbPayment: async () => null,
  loadInvoicePayments: async () => [],
  createRetailPaymentInQB: async () => { throw new Error('payment write not expected') },
}))
const keys = (c: { email?: string | null; phone?: string | null }) => [c.email?.trim().toLowerCase(), (c.phone ?? '').replace(/\D/g, '')].filter(Boolean)
const lookup = (c: { email?: string | null; phone?: string | null }) => { for (const k of keys(c)) { const id = qb.customers.get(k!); if (id) return id } return null }
vi.mock('@/apps/quickbooks/retail-customer', async (orig) => ({
  ...(await orig<object>()),
  resolveRetailCustomer: async (c: any) => {
    const id = lookup(c); if (!id) throw new Error('TEST: unknown customer')
    return { qbCustomerId: id, created: false, matchedBy: 'qb-email', directoryCustomerId: null, billEmail: c.email ?? null, emailStatus: 'match', emailConflict: false }
  },
  resolveRetailCustomerIdentity: async (c: any) => { const id = lookup(c); return { qbCustomerId: id, matchedBy: id ? 'qb-email' : 'none' } },
  resolveConfirmedRetailCustomer: async (c: any) => { const id = lookup(c); return { qbCustomerId: id, via: id ? 'qb-email' : 'none' } },
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { serviceOrders, vehicles, jobEstimates, retailInvoiceMembers, retailInvoiceConsolidations, serviceOrderEvents } from '@/drizzle/schema'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { getOrCreateEstimate, setExplicitPrice, recomputeEstimate, getEstimateRow } from '@/apps/workflow/estimate-db'
import { createRetailQBInvoice, sendRetailQBInvoice, syncRetailQBInvoice, loadJobDraft } from './retail-invoice-service'
import { findSharedInvoiceCandidates, linkToSharedInvoice, unlinkSharedInvoiceMember, loadSharedInvoiceState, previewSharedInvoiceUpdate, updateSharedInvoice } from './shared-invoice'
import {
  findCombineCandidates, previewCombineInvoices, startCombineInvoices, resumeCombineInvoices, cancelCombineInvoices,
  separateCombineInvoices, loadCombineState,
} from './invoice-consolidation'
import { planOrderRemoval } from '@/apps/workflow/order-removal'
import { previewRetailPayment } from './retail-payment-service'

let db: PgliteDatabase<typeof schema>
let seq = 0

const KELVIN = { name: 'Kelvin Cooper', email: 'kelvincooper@example.org', phone: '5125550199' }
const F250 = { year: '2018', make: 'Ford', model: 'F-250', vin: '1FT7W2BT0JE000001' }
const BMW = { year: '2022', make: 'BMW', model: '330i', vin: 'WBA5R1C00NF000002' }
const DONE_F250 = new Date('2026-10-22T19:54:58.728Z')
const DONE_BMW = new Date('2026-10-22T20:02:13.125Z')

async function retailJob(o: { name?: string; email?: string | null; phone?: string | null; vehicle: { year?: string; make: string; model: string; vin?: string }; work: number; source?: string; serviceType?: string; status?: string; completedAt?: Date }): Promise<string> {
  const [v] = await db.insert(vehicles).values({ year: o.vehicle.year ?? null, make: o.vehicle.make, model: o.vehicle.model, vin: o.vehicle.vin ?? null }).returning()
  const [so] = await db.insert(serviceOrders).values({ orderNumber: `CB-${++seq}`, vehicleId: v.id, source: o.source ?? 'quick_entry', serviceType: o.serviceType ?? 'retail', status: o.status ?? 'ready', customerName: o.name ?? KELVIN.name, services: ['Full Detail'], completedAt: o.completedAt ?? null }).returning()
  await db.insert(quickEntryJobs).values({ serviceOrderId: so.id, customerName: o.name ?? KELVIN.name, customerEmail: o.email === undefined ? KELVIN.email : o.email, customerPhone: o.phone === undefined ? KELVIN.phone : o.phone })
  const est = await getOrCreateEstimate(so.id, 'T')
  await setExplicitPrice(est.id, o.work, 'T')
  await recomputeEstimate(est.id)
  return so.id
}
const est = async (orderId: string) => (await getEstimateRow(orderId))!
const order = async (orderId: string) => (await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId)))[0]
const events = async (orderId: string) => (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))).map((e) => e.eventType)
const ops = async () => db.select().from(retailInvoiceConsolidations)
const members = async () => db.select().from(retailInvoiceMembers)
const inv = (id: string | null | undefined) => qb.invoices.get(String(id))

/** Kelvin today: two completed retail Jobs, each with its own unpaid app-created invoice (F-250 older). */
async function kelvinTwoInvoices(work = 15000) {
  const f250 = await retailJob({ vehicle: F250, work, completedAt: DONE_F250 })
  expect((await createRetailQBInvoice({ orderId: f250, actor: 'Manager' })).ok).toBe(true)
  const bmw = await retailJob({ vehicle: BMW, work, completedAt: DONE_BMW })
  expect((await createRetailQBInvoice({ orderId: bmw, actor: 'Manager' })).ok).toBe(true)
  return { f250, bmw }
}

/** Review then confirm, exactly as the screen does. */
async function combine(retainedOrderId: string, replacedOrderId: string, extra: { requestId?: string; acknowledgeEmailed?: boolean } = {}) {
  const p = await previewCombineInvoices({ orderId: retainedOrderId, otherOrderId: replacedOrderId, retainOrderId: retainedOrderId })
  expect(p.ok, p.error).toBe(true)
  return startCombineInvoices({
    retainedOrderId, replacedOrderId, requestId: extra.requestId ?? `req-${++seq}`, actor: 'Manager', acknowledgeEmailed: extra.acknowledgeEmailed,
    expected: { retainedSyncToken: p.retained!.syncToken, replacedSyncToken: p.replaced!.syncToken, combinedTotalCents: p.combinedTotalCents! },
  })
}

/** Run `fn` right after the claim statement commits (the durable row + pending member exist, no QB write yet). */
async function withAfterClaim<T>(fn: () => void | Promise<void>, body: () => Promise<T>): Promise<T> {
  const real = holder.db!
  let fired = false
  holder.db = new Proxy(real, {
    get(t, p) {
      const v = Reflect.get(t, p)
      if (p !== 'execute') return typeof v === 'function' ? v.bind(t) : v
      return async (q: unknown) => {
        const r = await (t as typeof real).execute(q as never)
        if (!fired && JSON.stringify(q).includes('INSERT INTO retail_invoice_members')) { fired = true; await fn() }
        return r
      }
    },
  }) as typeof real
  try { return await body() } finally { holder.db = real; expect(fired).toBe(true) }
}

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema }); holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]); await apply()
})
beforeEach(async () => {
  for (const t of ['retail_invoice_consolidations', 'retail_invoice_members', 'job_line_items', 'job_services', 'job_estimates', 'quick_entry_jobs', 'service_order_events', 'service_orders', 'vehicles']) await db.execute(sql.raw(`DELETE FROM ${t}`))
  qb.invoices.clear(); qb.customers.clear()
  qb.failRaw = 0; qb.realm = 'sandbox-realm'; qb.beforeVoid = null; qb.afterVoid = null; qb.voidMode = 'ok'; qb.beforeUpdate = null; qb.afterUpdate = null
  qb.calls = { create: 0, update: 0, send: 0, list: 0, raw: 0, void: 0 }
  qb.customers.set(KELVIN.email, 'C-KELVIN'); qb.customers.set(KELVIN.phone, 'C-KELVIN')
  qb.customers.set('other@example.org', 'C-OTHER')
})

describe('discovery and review (read-only)', () => {
  it('from EITHER completed Job, offers the other invoice of the same QuickBooks customer — nothing written', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const writes = () => qb.calls.create + qb.calls.update + qb.calls.void + qb.calls.send
    const w0 = writes()
    const fromBmw = await findCombineCandidates(bmw)
    expect(fromBmw).toMatchObject({ ok: true, invoiceNumber: (await est(bmw)).qbInvoiceNumber })
    expect(fromBmw.candidates).toEqual([expect.objectContaining({ orderId: f250, eligible: true, vehicle: '2018 Ford F-250', invoiceNumber: (await est(f250)).qbInvoiceNumber })])
    expect((await findCombineCandidates(f250)).candidates[0]).toMatchObject({ orderId: bmw, eligible: true })
    expect(writes()).toBe(w0)
    expect(await ops()).toHaveLength(0)
  })

  it('review: both invoices, each vehicle’s services and fees, combined total, which stays, what happens to the other', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const p = await previewCombineInvoices({ orderId: bmw, otherOrderId: f250 })
    expect(p.ok).toBe(true)
    // Neither emailed → the OLDER invoice (F-250) stays by default, whichever screen started it.
    expect(p.retained).toMatchObject({ orderId: f250, vehicle: '2018 Ford F-250', invoiceNumber: (await est(f250)).qbInvoiceNumber, emailed: false })
    expect(p.replaced).toMatchObject({ orderId: bmw, vehicle: '2022 BMW 330i', invoiceNumber: (await est(bmw)).qbInvoiceNumber, emailed: false })
    const a = await est(f250), b = await est(bmw)
    expect(p.retained!.totalCents).toBe(a.totalCents); expect(p.replaced!.totalCents).toBe(b.totalCents)
    expect(p.combinedTotalCents).toBe(a.totalCents + b.totalCents)
    expect(p.retained!.services.length).toBeGreaterThan(0)
    expect(p.retained!.shopSuppliesCents).toBeGreaterThan(0)
    // Combined presentation: one shop-supplies line for the two vehicles (each Job keeps its own amount inside it).
    const shop = p.combinedLines!.filter((l) => /shop supplies/i.test(l.description))
    expect(shop).toHaveLength(1)
    expect(shop[0].cents).toBe(p.retained!.shopSuppliesCents + p.replaced!.shopSuppliesCents)
    expect(p.combinedLines!.reduce((t, l) => t + (l.cents ?? 0), 0)).toBe(p.combinedTotalCents)
    expect(p.plan!.join(' ')).toMatch(/VOIDED in QuickBooks.*nothing is deleted/)
    expect(p.emailGuidance).toBeNull()
    // The manager can swap which invoice stays.
    expect((await previewCombineInvoices({ orderId: bmw, otherOrderId: f250, retainOrderId: bmw })).retained!.orderId).toBe(bmw)
  })

  it('an emailed invoice is the default one kept, and the review carries staff guidance', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    inv((await est(bmw)).qbInvoiceId).EmailStatus = 'EmailSent'
    await db.update(jobEstimates).set({ qbStatus: 'sent', qbSentAt: new Date() }).where(eq(jobEstimates.serviceOrderId, bmw))
    const p = await previewCombineInvoices({ orderId: f250, otherOrderId: bmw })
    expect(p.retained!.orderId).toBe(bmw)
    expect(p.emailedAny).toBe(true)
    expect(p.emailGuidance).toMatch(/resend/i)
  })

  it('never by name: a same-named customer with a different email is not offered; a name-only Job is blocked', async () => {
    const { f250 } = await kelvinTwoInvoices()
    const other = await retailJob({ email: 'other@example.org', phone: null, vehicle: { make: 'Toyota', model: 'Camry' }, work: 9000 })
    expect((await createRetailQBInvoice({ orderId: other, actor: 'M' })).ok).toBe(true)
    expect((await findCombineCandidates(f250)).candidates.map((c) => c.orderId)).not.toContain(other)
    expect(await previewCombineInvoices({ orderId: f250, otherOrderId: other })).toMatchObject({ ok: false })
  })

  it('dealer Jobs are refused before any QuickBooks lookup and never offered', async () => {
    const { f250 } = await kelvinTwoInvoices()
    const dealer = await retailJob({ vehicle: { make: 'Ford', model: 'Escape' }, work: 9000, source: 'dealer_checkin', serviceType: 'dealer_detail' })
    const raw0 = qb.calls.raw
    expect(await findCombineCandidates(dealer)).toMatchObject({ ok: true, blocked: expect.stringMatching(/Dealer/), candidates: [] })
    expect(qb.calls.raw).toBe(raw0)
    expect(await previewCombineInvoices({ orderId: f250, otherOrderId: dealer })).toMatchObject({ ok: false, error: expect.stringMatching(/Dealer/) })
  })

  it('paid, partially paid, voided, edited-in-QuickBooks, or already-shared invoices are refused', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const b = inv((await est(bmw)).qbInvoiceId)
    for (const [mutate, reason] of [
      [() => { b.Balance = b.TotalAmt - 10 }, /payment or credit/],
      [() => { b.Balance = 0 }, /paid/],
      [() => { b.LinkedTxn = [{ TxnId: '9', TxnType: 'Payment' }] }, /payment or credit/],
      [() => { b.PrivateNote = `Voided - ${b.PrivateNote}`; b.TotalAmt = 0; b.Balance = 0 }, /voided/],
      [() => { b.Line.push({ DetailType: 'SalesItemLineDetail', Amount: 5, Description: 'Added in QB', SalesItemLineDetail: { ItemRef: { value: '1' } } }) }, /changed in QuickBooks|doesn’t match/],
      [() => { b.Line.push({ DetailType: 'DiscountLineDetail', Amount: 5 }) }, /can’t rebuild/],
    ] as const) {
      const snapshot = clone(b)
      ;(mutate as () => void)()
      const p = await previewCombineInvoices({ orderId: f250, otherOrderId: bmw })
      expect(p.ok).toBe(false)
      expect(p.error).toMatch(reason)
      Object.keys(b).forEach((k) => delete b[k]); Object.assign(b, snapshot)
    }
    await db.update(jobEstimates).set({ qbPaymentStatus: 'recorded' }).where(eq(jobEstimates.serviceOrderId, bmw))
    expect(await previewCombineInvoices({ orderId: f250, otherOrderId: bmw })).toMatchObject({ ok: false, error: expect.stringMatching(/payment/) })
    await db.update(jobEstimates).set({ qbPaymentStatus: 'none' }).where(eq(jobEstimates.serviceOrderId, bmw))
    // A shared invoice with a vehicle still PENDING review fails closed (an APPLIED one may be kept — see "third vehicle").
    const third = await retailJob({ vehicle: { make: 'Honda', model: 'Accord' }, work: 8000 })
    const c = (await findSharedInvoiceCandidates(third)).candidates.find((x) => x.anchorOrderId === f250)!
    expect((await linkToSharedInvoice({ orderId: third, anchorOrderId: f250, invoiceId: c.invoiceId, expectedSyncToken: c.syncToken, actor: 'M' })).ok).toBe(true)
    expect(await previewCombineInvoices({ orderId: bmw, otherOrderId: f250 })).toMatchObject({ ok: false, error: expect.stringMatching(/waiting to be added/) })
  })
})

describe('combine — success', () => {
  it('completed Jobs: void the replaced invoice, retained invoice bills both, statuses/dates/history untouched, nothing emailed', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const [a0, b0] = [await est(f250), await est(bmw)]
    const [oa0, ob0] = [await order(f250), await order(bmw)]
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: true, status: 'completed', retainedInvoiceNumber: a0.qbInvoiceNumber, replacedInvoiceNumber: b0.qbInvoiceNumber, combinedTotalCents: a0.totalCents + b0.totalCents })

    // QuickBooks: the retained invoice carries both vehicles; the replaced one is VOID (kept, number intact, $0).
    const A = inv(a0.qbInvoiceId), B = inv(b0.qbInvoiceId)
    expect(Math.round(A.TotalAmt * 100)).toBe(a0.totalCents + b0.totalCents)
    expect(Math.round(A.Balance * 100)).toBe(a0.totalCents + b0.totalCents)
    expect(B).toMatchObject({ DocNumber: b0.qbInvoiceNumber, TotalAmt: 0, Balance: 0 })
    expect(B.PrivateNote).toMatch(/^Voided/)
    expect(qb.calls).toMatchObject({ void: 1, update: 1, send: 0, create: 2 })

    // Pitt Stop: both Jobs point at the SAME invoice; the replaced Job is an applied member.
    const [a1, b1] = [await est(f250), await est(bmw)]
    expect(a1).toMatchObject({ qbInvoiceId: a0.qbInvoiceId, qbStatus: 'created' })
    expect(b1).toMatchObject({ qbInvoiceId: null, qbInvoiceNumber: null, qbStatus: 'linked' })
    expect(await members()).toEqual([expect.objectContaining({ anchorServiceOrderId: f250, memberServiceOrderId: bmw, state: 'applied', appliedTotalCents: b0.totalCents })])
    const sa = await loadSharedInvoiceState(bmw)
    expect(sa).toMatchObject({ role: 'member', invoiceNumber: a0.qbInvoiceNumber, memberState: 'applied' })

    // The replaced invoice's identity is preserved durably.
    const [op] = await ops()
    expect(op).toMatchObject({ status: 'completed', replacedInvoiceId: b0.qbInvoiceId, replacedInvoiceNumber: b0.qbInvoiceNumber, replacedTotalCents: b0.totalCents, retainedInvoiceId: a0.qbInvoiceId, startedBy: 'Manager' })

    // Completion, status, services and dates never change.
    const [oa1, ob1] = [await order(f250), await order(bmw)]
    for (const [before, after] of [[oa0, oa1], [ob0, ob1]] as const) {
      expect(after.status).toBe(before.status)
      expect(after.completedAt?.toISOString()).toBe(before.completedAt?.toISOString())
      expect(after.services).toEqual(before.services)
    }
    expect(ob1.completedAt?.toISOString()).toBe(DONE_BMW.toISOString())
    expect(b1.totalCents).toBe(b0.totalCents)

    // Append-only history on BOTH Jobs.
    for (const id of [f250, bmw]) expect(await events(id)).toEqual(expect.arrayContaining(['invoice_combine_started', 'invoice_combine_voided', 'invoice_combine_relinked', 'invoice_combine_completed']))
    expect(await events(f250)).toContain('shared_invoice_updated')
    expect(await loadCombineState(bmw)).toMatchObject({ status: 'completed', role: 'replaced', active: false })
  })

  it('the replaced Job can never get a second invoice afterwards, and reports count each vehicle once', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    await combine(f250, bmw)
    expect(await createRetailQBInvoice({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, status: 'refused' })
    // The SAME predicate the marketing revenue report uses: invoiced if it owns an invoice OR is an applied member.
    const res = await db.execute(sql`SELECT je.service_order_id AS id, je.total_cents AS t FROM job_estimates je
      WHERE je.qb_invoice_id IS NOT NULL OR EXISTS (SELECT 1 FROM retail_invoice_members rim WHERE rim.member_estimate_id = je.id AND rim.state = 'applied')`)
    const rows = (res as unknown as { rows: Array<{ id: string; t: number }> }).rows
    expect(rows.map((r) => r.id).sort()).toEqual([f250, bmw].sort())
    expect(rows.reduce((s, r) => s + Number(r.t), 0)).toBe(Math.round(inv((await est(f250)).qbInvoiceId).TotalAmt * 100))
    // Open receivables in QuickBooks: only the retained invoice has a balance.
    const open = [...qb.invoices.values()].filter((i) => i.Balance > 0)
    expect(open).toHaveLength(1)
  })

  it('emailed invoice → refused without acknowledgement; with it, combined, never emailed, resend flagged', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    inv((await est(f250)).qbInvoiceId).EmailStatus = 'EmailSent'
    await db.update(jobEstimates).set({ qbStatus: 'sent', qbSentAt: new Date() }).where(eq(jobEstimates.serviceOrderId, f250))
    expect(await combine(f250, bmw)).toMatchObject({ ok: false, block: 'confirm_required' })
    expect(await ops()).toHaveLength(0)
    expect(qb.calls.void).toBe(0)
    const r = await combine(f250, bmw, { acknowledgeEmailed: true })
    expect(r).toMatchObject({ ok: true, status: 'completed' })
    expect(qb.calls.send).toBe(0)
    expect(await est(f250)).toMatchObject({ qbStatus: 'sent', qbSyncError: 'Resend recommended — invoice changed after it was emailed' })
    expect((await ops())[0]).toMatchObject({ emailedAcknowledged: true, retainedEmailed: true })
  })
})

describe('stale / changed invoices', () => {
  it('reviewed versions are enforced: a changed invoice after review → stale, nothing claimed or written', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const p = await previewCombineInvoices({ orderId: f250, otherOrderId: bmw, retainOrderId: f250 })
    inv((await est(bmw)).qbInvoiceId).SyncToken = '7'
    const r = await startCombineInvoices({ retainedOrderId: f250, replacedOrderId: bmw, requestId: 'r1', actor: 'M', expected: { retainedSyncToken: p.retained!.syncToken, replacedSyncToken: p.replaced!.syncToken, combinedTotalCents: p.combinedTotalCents! } })
    expect(r).toMatchObject({ ok: false, block: 'stale' })
    expect(await ops()).toHaveLength(0); expect(await members()).toHaveLength(0)
    expect(qb.calls.void).toBe(0)
    expect((await est(bmw)).qbStatus).toBe('created')
  })

  it('a payment lands on the REPLACED invoice right before the void → QuickBooks refuses the void (stale), combine cancelled, both unchanged', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const b0 = await est(bmw)
    qb.beforeVoid = async () => { const b = inv(b0.qbInvoiceId); b.Balance = b.TotalAmt - 50; b.LinkedTxn = [{ TxnId: '77', TxnType: 'Payment' }]; b.SyncToken = String(Number(b.SyncToken) + 1) }
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: false, status: 'cancelled', block: 'stale' })
    expect(inv(b0.qbInvoiceId).PrivateNote).not.toMatch(/Voided/)
    expect(await est(bmw)).toMatchObject({ qbInvoiceId: b0.qbInvoiceId, qbStatus: 'created' })
    expect((await members())[0]).toMatchObject({ state: 'removed' })
    expect(qb.calls.update).toBe(0)
    expect(await events(bmw)).toContain('invoice_combine_cancelled')
    // Both are free again (a fresh review would now refuse the partly paid one).
    expect(await previewCombineInvoices({ orderId: f250, otherOrderId: bmw })).toMatchObject({ ok: false, error: expect.stringMatching(/payment/) })
  })

  it('the RETAINED invoice changes in QuickBooks between claim and void → cancelled before any write', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const a0 = await est(f250)
    // A QuickBooks-side edit lands right after the claim, before step 1 re-reads.
    const r = await withAfterClaim(() => { inv(a0.qbInvoiceId).SyncToken = '9' }, () => combine(f250, bmw))
    expect(r).toMatchObject({ ok: false, status: 'cancelled' })
    expect(qb.calls.void).toBe(0)
    expect((await est(bmw)).qbStatus).toBe('created')
  })

  it('a payment on the RETAINED invoice after the void → update refused, vehicle not double-billed, Bill separately recovers', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const [a0, b0] = [await est(f250), await est(bmw)]
    qb.afterVoid = async () => { const a = inv(a0.qbInvoiceId); a.Balance = a.TotalAmt - 20; a.LinkedTxn = [{ TxnId: '5', TxnType: 'Payment' }]; a.SyncToken = String(Number(a.SyncToken) + 1) }
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: false, status: 'relinked', block: 'attention' })
    expect(r.error).toMatch(/payment or credit/i)
    expect(qb.calls.update).toBe(0)
    // Never billed twice: B is void, A still holds only its own charges.
    expect(inv(b0.qbInvoiceId).TotalAmt).toBe(0)
    expect(Math.round(inv(a0.qbInvoiceId).TotalAmt * 100)).toBe(a0.totalCents)
    // Both blocked while unfinished: A can't be sent (pending member), B can't create a new invoice.
    expect(await sendRetailQBInvoice({ orderId: f250, actor: 'M' })).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(await createRetailQBInvoice({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, status: 'refused' })
    expect(await loadCombineState(bmw)).toMatchObject({ active: true, status: 'relinked', canSeparate: true, canCancel: false })
    expect(await cancelCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'not_allowed' })
    // Recovery: bill the BMW separately → it gets a NEW invoice (the voided one is never re-adopted).
    expect(await separateCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: true, status: 'separated' })
    expect(await est(bmw)).toMatchObject({ qbStatus: 'none', qbInvoiceId: null })
    const c = await createRetailQBInvoice({ orderId: bmw, actor: 'M' })
    expect(c).toMatchObject({ ok: true, status: 'created' })
    expect(c.adopted).toBeFalsy()
    expect(c.invoiceId).not.toBe(b0.qbInvoiceId)
    expect((await members())[0]).toMatchObject({ state: 'removed' })
    expect(await events(bmw)).toContain('invoice_combine_separated')
  })
})

describe('concurrency, double taps, retries', () => {
  it('double tap (same request id) → one consolidation, one void, one update', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const p = await previewCombineInvoices({ orderId: f250, otherOrderId: bmw, retainOrderId: f250 })
    const args = { retainedOrderId: f250, replacedOrderId: bmw, requestId: 'tap', actor: 'M', expected: { retainedSyncToken: p.retained!.syncToken, replacedSyncToken: p.replaced!.syncToken, combinedTotalCents: p.combinedTotalCents! } }
    const [r1, r2] = await Promise.all([startCombineInvoices(args), startCombineInvoices(args)])
    expect([r1, r2].some((r) => r.ok)).toBe(true)
    expect([r1, r2].every((r) => r.ok || r.block === 'busy')).toBe(true)
    expect(await ops()).toHaveLength(1)
    expect(qb.calls).toMatchObject({ void: 1, update: 1 })
    // A replay after completion reports the finished result without touching QuickBooks again.
    expect(await startCombineInvoices(args)).toMatchObject({ ok: true, status: 'completed', alreadyDone: true })
    expect(qb.calls).toMatchObject({ void: 1, update: 1 })
  })

  it('two different requests racing for the same invoices → exactly one claims', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const p = await previewCombineInvoices({ orderId: f250, otherOrderId: bmw, retainOrderId: f250 })
    const expected = { retainedSyncToken: p.retained!.syncToken, replacedSyncToken: p.replaced!.syncToken, combinedTotalCents: p.combinedTotalCents! }
    const q = await previewCombineInvoices({ orderId: f250, otherOrderId: bmw, retainOrderId: bmw })
    const swapped = { retainedSyncToken: q.retained!.syncToken, replacedSyncToken: q.replaced!.syncToken, combinedTotalCents: q.combinedTotalCents! }
    const rs = await Promise.all([
      startCombineInvoices({ retainedOrderId: f250, replacedOrderId: bmw, requestId: 'x1', actor: 'M', expected }),
      startCombineInvoices({ retainedOrderId: bmw, replacedOrderId: f250, requestId: 'x2', actor: 'M', expected: swapped }),
    ])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(await ops()).toHaveLength(1)
    expect(qb.calls.void).toBe(1)
    expect(qb.calls.update).toBe(1)
    const live = [...qb.invoices.values()].filter((i) => i.TotalAmt > 0)
    expect(live).toHaveLength(1)   // exactly one invoice bills Kelvin, for both vehicles
  })

  it('DB backstop: one unfinished combine per QuickBooks customer (keep C / void A cannot claim while A is retained elsewhere)', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const third = await retailJob({ vehicle: { year: '2015', make: 'Honda', model: 'Civic' }, work: 9000, completedAt: DONE_BMW })
    expect((await createRetailQBInvoice({ orderId: third, actor: 'Manager' })).ok).toBe(true)
    // First combine stays unfinished (QuickBooks unreachable after the claim).
    await withAfterClaim(() => { qb.failRaw = 1 }, () => combine(f250, bmw))
    const [op1] = await ops(); expect(op1.status).toBe('prepared')
    const a = await est(f250); const c = await est(third)
    // A racing claim that slipped past the NOT EXISTS checks: retained C, replaced A (A is retained in op1).
    await expect(db.execute(sql`
      INSERT INTO retail_invoice_consolidations (request_id, retained_estimate_id, retained_service_order_id, replaced_estimate_id, replaced_service_order_id,
        qb_customer_id, qb_realm_id, retained_invoice_id, retained_sync_token, retained_lines_fingerprint, retained_total_cents,
        replaced_invoice_id, replaced_sync_token, replaced_lines_fingerprint, replaced_total_cents, replaced_prior_qb_status, combined_total_cents)
      VALUES ('race', ${c.id}::uuid, ${third}::uuid, ${a.id}::uuid, ${f250}::uuid, ${op1.qbCustomerId}, ${op1.qbRealmId}, ${c.qbInvoiceId}, '0', 'x', 1, ${a.qbInvoiceId}, '0', 'x', 1, 'created', 2)`).catch((e: { message?: string; cause?: { message?: string } }) => { throw new Error(String(e?.cause?.message ?? e?.message)) })).rejects.toThrow(/ric_customer_active_uniq/)
    // The app path refuses it too, before any write.
    expect((await previewCombineInvoices({ orderId: third, otherOrderId: f250, retainOrderId: third })).ok).toBe(false)
    expect(qb.calls.void).toBe(0)
  })

  it('a replaced invoice zeroed out by hand (no QuickBooks "Voided" marker) is never adopted as voided NOR auto-cancelled → reconcile; restoring its charges then cancels cleanly', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const b0 = await est(bmw)
    const saved = clone(inv(b0.qbInvoiceId))
    const r = await withAfterClaim(() => { const b = inv(b0.qbInvoiceId); b.TotalAmt = 0; b.Balance = 0; b.SyncToken = String(Number(b.SyncToken) + 1) }, () => combine(f250, bmw))
    expect(r).toMatchObject({ ok: false, block: 'attention', status: 'prepared', error: expect.stringMatching(/can’t confirm it was voided/) })
    expect(qb.calls.void).toBe(0)
    expect((await ops())[0].voidedAt).toBeNull()
    expect(await cancelCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'attention' })
    expect(await est(bmw)).toMatchObject({ qbStatus: 'consolidating' })   // still blocked
    // A person restores its charges in QuickBooks → Retry sees a changed (live) invoice and cancels; nothing voided.
    Object.assign(inv(b0.qbInvoiceId), { TotalAmt: saved.TotalAmt, Balance: saved.Balance, SyncToken: String(Number(saved.SyncToken) + 2) })
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ status: 'cancelled', block: 'stale' })
    expect(qb.calls.void).toBe(0)
    expect(await est(bmw)).toMatchObject({ qbInvoiceId: b0.qbInvoiceId, qbStatus: 'created' })
  })

  it('a concurrent Send of the replaced invoice wins the race → combine refused, nothing written', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const p = await previewCombineInvoices({ orderId: f250, otherOrderId: bmw, retainOrderId: f250 })
    await db.update(jobEstimates).set({ qbStatus: 'sending' }).where(eq(jobEstimates.serviceOrderId, bmw))   // Send holds its lock
    const r = await startCombineInvoices({ retainedOrderId: f250, replacedOrderId: bmw, requestId: 's1', actor: 'M', expected: { retainedSyncToken: p.retained!.syncToken, replacedSyncToken: p.replaced!.syncToken, combinedTotalCents: p.combinedTotalCents! } })
    expect(r.ok).toBe(false)
    expect(await ops()).toHaveLength(0); expect(qb.calls.void).toBe(0)
  })
})

describe('every write boundary: failure and recovery', () => {
  it('void response lost but QuickBooks voided → read back, adopted, never voided twice, completes', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.voidMode = 'lost_response'
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: true, status: 'completed' })
    expect(qb.calls.void).toBe(1)
  })

  it('void timed out and did NOT land → blocked with attention; Retry voids and completes', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const b0 = await est(bmw)
    qb.voidMode = 'timeout_not_applied'
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: false, status: 'prepared', block: 'attention' })
    expect(r.error).toMatch(/may or may not/)
    // Both invoices blocked meanwhile.
    expect(await sendRetailQBInvoice({ orderId: f250, actor: 'M' })).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(await sendRetailQBInvoice({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false })
    expect(await previewRetailPayment({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false })
    expect(await syncRetailQBInvoice({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false })
    expect(qb.calls.send).toBe(0)
    // Cancel is refused right after an uncertain void (it could still land) …
    expect(await cancelCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'busy' })
    // … Retry checks QuickBooks and continues.
    qb.voidMode = 'ok'
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: true, status: 'completed' })
    expect(inv(b0.qbInvoiceId).TotalAmt).toBe(0)
  })

  it('QuickBooks unreachable right after the claim → attention, nothing written, both blocked; Retry completes', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const r = await withAfterClaim(() => { qb.failRaw = 1 }, () => combine(f250, bmw))
    expect(r).toMatchObject({ ok: false, status: 'prepared', block: 'qb_read_failed' })
    expect(qb.calls.void).toBe(0)
    expect((await est(bmw)).qbStatus).toBe('consolidating')
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: true, status: 'completed' })
  })

  it('void landed, then the process died before recording it → Retry adopts the void and completes', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.voidMode = 'lost_response'
    // The lost response is followed by a failed read-back: the outcome is unknown to Pitt Stop.
    qb.afterVoid = async () => { qb.failRaw = 1 }
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: false, status: 'prepared', block: 'attention' })
    expect((await ops())[0].voidAttemptedAt).not.toBeNull()
    qb.voidMode = 'ok'
    const r2 = await resumeCombineInvoices({ orderId: f250, actor: 'M' })
    expect(r2).toMatchObject({ ok: true, status: 'completed' })
    expect(qb.calls.void).toBe(1)   // adopted from QuickBooks, never voided again
    expect(await events(bmw)).toContain('invoice_combine_attention')
  })

  it('update of the retained invoice fails before writing → attention after the void; Retry completes with no duplicate', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const a0 = await est(f250), b0 = await est(bmw)
    qb.beforeUpdate = async () => { throw new Error('ETIMEDOUT') }
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: false, status: 'relinked', block: 'attention' })
    expect(Math.round(inv(a0.qbInvoiceId).TotalAmt * 100)).toBe(a0.totalCents)
    const rv = await previewSharedInvoiceUpdate(f250, { forCombine: true })
    expect(rv.blockers).toEqual([])
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', expectedSyncToken: rv.syncToken, combinedTotalCents: rv.combinedTotalCents })).toMatchObject({ ok: true, status: 'completed' })
    expect(Math.round(inv(a0.qbInvoiceId).TotalAmt * 100)).toBe(a0.totalCents + b0.totalCents)
  })

  it('update LANDED but its response / finalization was lost → Retry with a fresh review reconciles, billed once', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const a0 = await est(f250), b0 = await est(bmw)
    qb.afterUpdate = async () => { throw new Error('socket hang up') }
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: false, status: 'relinked' })
    expect(Math.round(inv(a0.qbInvoiceId).TotalAmt * 100)).toBe(a0.totalCents + b0.totalCents)   // landed
    expect((await members())[0].state).toBe('pending')
    // Bill separately is refused: first while the update may still be landing (settle window), then because the
    // retained invoice already carries the BMW's charges.
    expect(await separateCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'busy', error: expect.stringMatching(/may still land/) })
    await db.update(retailInvoiceConsolidations).set({ updateAttemptedAt: new Date(Date.now() - 3 * 60_000) })
    expect(await separateCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'not_allowed' })
    // The original review token is stale now — Retry without a fresh review asks for one.
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'stale' })
    const rv = await previewSharedInvoiceUpdate(f250, { forCombine: true })
    expect(rv.blockers).toEqual([])
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', expectedSyncToken: rv.syncToken, combinedTotalCents: rv.combinedTotalCents })).toMatchObject({ ok: true, status: 'completed' })
    expect(Math.round(inv(a0.qbInvoiceId).TotalAmt * 100)).toBe(a0.totalCents + b0.totalCents)
    expect([...qb.invoices.values()].filter((i) => i.TotalAmt > 0)).toHaveLength(1)
  })

  it('the shared-invoice "Update invoice" can’t finish an unfinished combine behind its back (server-side) — only the combine’s Finish can', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.beforeUpdate = async () => { throw new Error('ETIMEDOUT') }
    await combine(f250, bmw)
    const rv = await previewSharedInvoiceUpdate(f250)
    expect(rv.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/combine of this invoice is unfinished/)]))
    const u0 = qb.calls.update
    expect(await updateSharedInvoice({ orderId: f250, actor: 'M', expectedSyncToken: rv.syncToken })).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(qb.calls.update).toBe(u0)
    const fresh = await previewSharedInvoiceUpdate(f250, { forCombine: true })
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', expectedSyncToken: fresh.syncToken })).toMatchObject({ ok: true, status: 'completed' })
    expect(await loadCombineState(f250)).toMatchObject({ status: 'completed', active: false })
  })

  it('Cancel before the void restores both invoices exactly; Cancel is refused once the invoice is voided', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const b0 = await est(bmw)
    qb.voidMode = 'timeout_not_applied'
    await combine(f250, bmw)
    await db.update(retailInvoiceConsolidations).set({ voidAttemptedAt: new Date(Date.now() - 10 * 60 * 1000) })
    expect(await cancelCombineInvoices({ orderId: f250, actor: 'M' })).toMatchObject({ ok: true, status: 'cancelled' })
    expect(await est(bmw)).toMatchObject({ qbStatus: 'created', qbInvoiceId: b0.qbInvoiceId })
    expect((await members())[0].state).toBe('removed')
    expect(inv(b0.qbInvoiceId).PrivateNote).not.toMatch(/Voided/)
    expect(await loadCombineState(bmw)).toBeNull()
    // Normal billing works again.
    qb.voidMode = 'ok'
    expect(await combine(f250, bmw)).toMatchObject({ ok: true, status: 'completed' })
  })

  it('a crashed worker’s lease blocks a second worker only until it expires', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.voidMode = 'timeout_not_applied'
    await combine(f250, bmw)
    await db.update(retailInvoiceConsolidations).set({ leaseOwner: 'dead-worker', leaseExpiresAt: new Date(Date.now() + 60_000) })
    qb.voidMode = 'ok'
    expect(await resumeCombineInvoices({ orderId: f250, actor: 'M' })).toMatchObject({ ok: false, block: 'busy' })
    expect(qb.calls.void).toBe(1)
    await db.update(retailInvoiceConsolidations).set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    expect(await resumeCombineInvoices({ orderId: f250, actor: 'M' })).toMatchObject({ ok: true, status: 'completed' })
  })
})

describe('other billing actions on BOTH invoices are blocked while a combine is unfinished', () => {
  it('link / unlink / removal / sync / send / create are refused; the shared update review points to the combine', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.voidMode = 'timeout_not_applied'
    await combine(f250, bmw)   // stuck in 'prepared' (uncertain void)
    const third = await retailJob({ vehicle: { make: 'Honda', model: 'Accord' }, work: 8000 })
    const c = (await findSharedInvoiceCandidates(third)).candidates.find((x) => x.anchorOrderId === f250)
    expect(c?.eligible ?? false).toBe(false)
    expect((await linkToSharedInvoice({ orderId: third, anchorOrderId: f250, invoiceId: String((await est(f250)).qbInvoiceId), actor: 'M' })).ok).toBe(false)
    expect(await unlinkSharedInvoiceMember({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'busy' })
    for (const id of [bmw, f250]) { const pr = await planOrderRemoval(id); expect(pr.ok === false || pr.preview?.blocked === true).toBe(true) }
    // Active (not yet completed) Jobs mid-combine: removal is refused with the combine named.
    await db.update(serviceOrders).set({ status: 'in_progress' }).where(eq(serviceOrders.id, bmw))
    expect((await planOrderRemoval(bmw)).preview).toMatchObject({ blocked: true, reason: expect.stringMatching(/combine/i) })
    expect(await syncRetailQBInvoice({ orderId: f250, actor: 'M' })).toMatchObject({ ok: false, block: 'shared_pending' })
    const rv = await previewSharedInvoiceUpdate(f250, { forCombine: true })
    expect(rv.blockers!.join(' ')).toMatch(/combine is still voiding/)
    expect(await updateSharedInvoice({ orderId: f250, actor: 'M', expectedSyncToken: rv.syncToken })).toMatchObject({ ok: false })
    expect(qb.calls.update).toBe(0)
    // A second combine touching either invoice is refused.
    const p = await previewCombineInvoices({ orderId: third, otherOrderId: f250 })
    expect(p.ok).toBe(false)
    expect(qb.calls.send).toBe(0)
  })
})

/** Run `fn` right BEFORE the claim statement executes (after the review passed) — a competitor slipping in. */
async function withBeforeClaim<T>(fn: () => Promise<void>, body: () => Promise<T>): Promise<T> {
  const real = holder.db!
  let fired = false
  holder.db = new Proxy(real, {
    get(t, p) {
      const v = Reflect.get(t, p)
      if (p !== 'execute') return typeof v === 'function' ? v.bind(t) : v
      return async (q: unknown) => {
        if (!fired && JSON.stringify(q).includes('INSERT INTO retail_invoice_consolidations')) { fired = true; await fn() }
        return (t as typeof real).execute(q as never)
      }
    },
  }) as typeof real
  try { return await body() } finally { holder.db = real; expect(fired).toBe(true) }
}
async function kelvinFourInvoices() {
  const { f250, bmw } = await kelvinTwoInvoices()
  const civic = await retailJob({ vehicle: { year: '2015', make: 'Honda', model: 'Civic' }, work: 9000, completedAt: DONE_BMW })
  const camry = await retailJob({ vehicle: { year: '2019', make: 'Toyota', model: 'Camry' }, work: 7000, completedAt: DONE_BMW })
  for (const id of [civic, camry]) expect((await createRetailQBInvoice({ orderId: id, actor: 'Manager' })).ok).toBe(true)
  return { f250, bmw, civic, camry }
}
const settle = () => db.update(retailInvoiceConsolidations).set({ voidAttemptedAt: new Date(Date.now() - 10 * 60 * 1000) })

describe('review fixes: one unfinished combine per customer (realm-scoped)', () => {
  it('a second combine for the same customer is refused gracefully while the first is unfinished — at review AND at confirm', async () => {
    const { f250, bmw, civic, camry } = await kelvinFourInvoices()
    qb.voidMode = 'timeout_not_applied'
    await combine(f250, bmw)                                   // unfinished (prepared, uncertain void)
    expect((await ops())[0]).toMatchObject({ status: 'prepared', qbRealmId: 'sandbox-realm', qbCustomerId: 'C-KELVIN' })
    qb.voidMode = 'ok'
    const p = await previewCombineInvoices({ orderId: civic, otherOrderId: camry })
    expect(p).toMatchObject({ ok: false, error: expect.stringMatching(/already has an unfinished combine.*only one combine per customer/) })
    expect(qb.calls.void).toBe(1)
    expect((await est(civic)).qbStatus).toBe('created'); expect((await est(camry)).qbStatus).toBe('created')
    // Finishing the first frees the customer.
    expect(await resumeCombineInvoices({ orderId: f250, actor: 'M' })).toMatchObject({ ok: true, status: 'completed' })
    expect(await combine(civic, camry)).toMatchObject({ ok: true, status: 'completed' })
  })

  it('a concurrent start that claims first (lands between the review and the claim) → the DB index refuses the loser: busy, nothing written', async () => {
    const { f250, bmw, civic, camry } = await kelvinFourInvoices()
    const [a, b] = [await est(f250), await est(bmw)]
    const p = await previewCombineInvoices({ orderId: civic, otherOrderId: camry, retainOrderId: civic })
    expect(p.ok).toBe(true)
    const r = await withBeforeClaim(async () => {
      // The competitor's committed claim for the same customer (keep F-250 / void BMW).
      await holder.db!.insert(retailInvoiceConsolidations).values({ requestId: 'competitor', status: 'prepared', retainedEstimateId: a.id, retainedServiceOrderId: f250, replacedEstimateId: b.id, replacedServiceOrderId: bmw,
        qbCustomerId: 'C-KELVIN', qbRealmId: 'sandbox-realm', retainedInvoiceId: a.qbInvoiceId!, retainedSyncToken: '0', retainedLinesFingerprint: 'x', retainedTotalCents: a.totalCents,
        replacedInvoiceId: b.qbInvoiceId!, replacedSyncToken: '0', replacedLinesFingerprint: 'y', replacedTotalCents: b.totalCents, replacedPriorQbStatus: 'created', combinedTotalCents: a.totalCents + b.totalCents })
    }, () => startCombineInvoices({ retainedOrderId: civic, replacedOrderId: camry, requestId: 'loser', actor: 'M',
      expected: { retainedSyncToken: p.retained!.syncToken, replacedSyncToken: p.replaced!.syncToken, combinedTotalCents: p.combinedTotalCents! } }))
    expect(r).toMatchObject({ ok: false, block: 'busy', error: expect.stringMatching(/already has an unfinished combine/) })
    expect((await ops()).map((o) => o.requestId)).toEqual(['competitor'])
    expect(await members()).toHaveLength(0)
    expect((await est(camry)).qbStatus).toBe('created')         // the claim statement rolled back as a whole
    expect(qb.calls.void).toBe(0)
  })

  it('the same customer id in ANOTHER QuickBooks company is a different customer — not blocked', async () => {
    const { f250, bmw, civic, camry } = await kelvinFourInvoices()
    const [a, b] = [await est(f250), await est(bmw)]
    await db.insert(retailInvoiceConsolidations).values({ requestId: 'other-company', status: 'relinked', retainedEstimateId: a.id, retainedServiceOrderId: f250, replacedEstimateId: b.id, replacedServiceOrderId: bmw,
      qbCustomerId: 'C-KELVIN', qbRealmId: 'some-other-realm', retainedInvoiceId: 'X1', retainedSyncToken: '0', retainedLinesFingerprint: 'x', retainedTotalCents: 1,
      replacedInvoiceId: 'X2', replacedSyncToken: '0', replacedLinesFingerprint: 'y', replacedTotalCents: 1, replacedPriorQbStatus: 'created', combinedTotalCents: 2 })
    expect(await combine(civic, camry)).toMatchObject({ ok: true, status: 'completed' })
  })

  it('QuickBooks reconnected to a different company mid-combine → every QuickBooks step stops (no void, no cancel), resumes once restored', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.voidMode = 'timeout_not_applied'
    await combine(f250, bmw)
    await settle(); qb.voidMode = 'ok'
    qb.realm = 'another-company'
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, status: 'prepared', block: 'attention', error: expect.stringMatching(/different company/) })
    expect(await cancelCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'attention' })
    qb.realm = null
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'qb_read_failed' })
    expect(qb.calls.void).toBe(1)                               // only the original uncertain attempt
    expect(await events(bmw)).not.toContain('invoice_combine_voided')
    qb.realm = 'sandbox-realm'
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: true, status: 'completed' })
  })
})

describe('review fixes: emailed acknowledgement enforced server-side on Finish / Retry', () => {
  async function stuckBeforeUpdate(opts: { ackAtStart?: boolean } = {}) {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.beforeUpdate = async () => { throw new Error('ETIMEDOUT') }
    const r = await combine(f250, bmw, { acknowledgeEmailed: opts.ackAtStart })
    expect(r).toMatchObject({ ok: false, status: 'relinked' })
    return { f250, bmw }
  }
  const emailFromQuickBooks = async (orderId: string) => { const a = inv((await est(orderId)).qbInvoiceId); a.EmailStatus = 'EmailSent'; a.SyncToken = String(Number(a.SyncToken) + 1) }

  it('retained invoice emailed straight from QuickBooks mid-combine → Retry without acknowledgement writes nothing; with it, finishes and records the acknowledgement', async () => {
    const { f250, bmw } = await stuckBeforeUpdate()
    await emailFromQuickBooks(f250)
    const rv = await previewSharedInvoiceUpdate(f250, { forCombine: true })
    expect(rv).toMatchObject({ emailed: true, blockers: [] })
    const u0 = qb.calls.update
    const refused = await resumeCombineInvoices({ orderId: bmw, actor: 'M', expectedSyncToken: rv.syncToken, combinedTotalCents: rv.combinedTotalCents })
    expect(refused).toMatchObject({ ok: false, block: 'confirm_required', status: 'relinked', error: expect.stringMatching(/emailed to the customer after this combine was reviewed/) })
    expect(qb.calls.update).toBe(u0)
    expect((await members())[0].state).toBe('pending')
    const done = await resumeCombineInvoices({ orderId: bmw, actor: 'M', expectedSyncToken: rv.syncToken, combinedTotalCents: rv.combinedTotalCents, confirmSent: true })
    expect(done).toMatchObject({ ok: true, status: 'completed' })
    expect(qb.calls.send).toBe(0)
    expect(await events(f250)).toContain('invoice_combine_email_acknowledged')
  })

  it('an acknowledgement given at start for the REPLACED invoice does not cover the retained one being emailed later', async () => {
    const { f250, bmw } = await (async () => {
      const { f250, bmw } = await kelvinTwoInvoices()
      inv((await est(bmw)).qbInvoiceId).EmailStatus = 'EmailSent'
      await db.update(jobEstimates).set({ qbStatus: 'sent', qbSentAt: new Date() }).where(eq(jobEstimates.serviceOrderId, bmw))
      qb.beforeUpdate = async () => { throw new Error('ETIMEDOUT') }
      expect(await combine(f250, bmw, { acknowledgeEmailed: true })).toMatchObject({ ok: false, status: 'relinked' })   // keep the F-250 explicitly
      return { f250, bmw }
    })()
    expect((await ops())[0]).toMatchObject({ emailedAcknowledged: true, retainedEmailed: false, replacedEmailed: true })
    await emailFromQuickBooks(f250)
    const rv = await previewSharedInvoiceUpdate(f250, { forCombine: true })
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', expectedSyncToken: rv.syncToken, combinedTotalCents: rv.combinedTotalCents })).toMatchObject({ ok: false, block: 'confirm_required' })
  })

  it('an invoice already emailed AND acknowledged at start needs no second acknowledgement', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    inv((await est(f250)).qbInvoiceId).EmailStatus = 'EmailSent'
    await db.update(jobEstimates).set({ qbStatus: 'sent', qbSentAt: new Date() }).where(eq(jobEstimates.serviceOrderId, f250))
    qb.beforeUpdate = async () => { throw new Error('ETIMEDOUT') }
    expect(await combine(f250, bmw, { acknowledgeEmailed: true })).toMatchObject({ ok: false, status: 'relinked' })
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: true, status: 'completed' })
    expect(await events(f250)).not.toContain('invoice_combine_email_acknowledged')
  })
})

describe('review fixes: a genuine void vs an invoice merely reduced to $0', () => {
  it('after an uncertain void, QuickBooks shows #B at $0 WITHOUT the "Voided" marker → reconcile: no void recorded, no cancel; a real void in QuickBooks then lets Retry finish', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const b0 = await est(bmw)
    qb.voidMode = 'timeout_not_applied'
    await combine(f250, bmw)
    await settle()
    const B = inv(b0.qbInvoiceId); B.TotalAmt = 0; B.Balance = 0; B.SyncToken = String(Number(B.SyncToken) + 1)   // zeroed by hand
    qb.voidMode = 'ok'
    const r = await resumeCombineInvoices({ orderId: bmw, actor: 'M' })
    expect(r).toMatchObject({ ok: false, status: 'prepared', block: 'attention', error: expect.stringMatching(/can’t confirm it was voided/) })
    expect(await cancelCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'attention' })
    expect(await events(bmw)).not.toContain('invoice_combine_voided')
    expect(await events(bmw)).not.toContain('invoice_combine_cancelled')
    expect(await est(bmw)).toMatchObject({ qbStatus: 'consolidating', qbInvoiceId: b0.qbInvoiceId })   // still blocked from billing
    expect(qb.calls.void).toBe(1)
    // A person voids it properly in QuickBooks → Retry adopts the confirmed void and finishes.
    B.PrivateNote = `Voided - ${B.PrivateNote}`
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: true, status: 'completed' })
    expect(qb.calls.void).toBe(1)
  })

  it('…or the person restores its charges instead → Retry sees a changed invoice and cancels cleanly (no void recorded)', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const b0 = await est(bmw)
    qb.voidMode = 'timeout_not_applied'
    await combine(f250, bmw)
    await settle()
    const B = inv(b0.qbInvoiceId); const total = B.TotalAmt
    B.TotalAmt = 0; B.Balance = 0; B.SyncToken = String(Number(B.SyncToken) + 1)
    qb.voidMode = 'ok'
    expect((await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).block).toBe('attention')
    B.TotalAmt = total; B.Balance = total; B.SyncToken = String(Number(B.SyncToken) + 1)
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, status: 'cancelled', block: 'stale' })
    expect(await events(bmw)).not.toContain('invoice_combine_voided')
    expect(await est(bmw)).toMatchObject({ qbStatus: 'created', qbInvoiceId: b0.qbInvoiceId })
  })

  it('a void response with the marker but NOT zeroed amounts is never recorded as a void → reconcile, both invoices stay blocked', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.voidMode = 'marker_only'
    const r = await combine(f250, bmw)
    expect(r).toMatchObject({ ok: false, status: 'prepared', block: 'attention', error: expect.stringMatching(/can’t confirm it was voided/) })
    expect(await events(bmw)).not.toContain('invoice_combine_voided')
    expect(await sendRetailQBInvoice({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false })
    expect(await sendRetailQBInvoice({ orderId: f250, actor: 'M' })).toMatchObject({ ok: false, block: 'shared_pending' })
    // Retry keeps refusing to guess (no second void, no cancel).
    qb.voidMode = 'ok'; await settle()
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'attention' })
    expect(qb.calls.void).toBe(1)
  })
})

// ── Kelvin's real case and his THIRD vehicle ─────────────────────────────────────────────────────────────
const TAHOE = { year: '2020', make: 'Chevrolet', model: 'Tahoe', vin: '1GNSKBKC0LR000003' }
type RawLine = { DetailType: string; Amount?: number; Description?: string }
const lineView = (id: string | null | undefined) => (inv(id).Line as RawLine[]).map((l) => (l.DetailType === 'DescriptionOnly' ? `# ${l.Description}` : `${l.Description} ${l.Amount}`))
const qbCents = (id: string | null | undefined) => ({ total: Math.round(inv(id).TotalAmt * 100), balance: Math.round(inv(id).Balance * 100) })

/** #A bills F-250 + BMW (combined); #B voided. */
async function kelvinCombined() {
  const { f250, bmw } = await kelvinTwoInvoices()
  expect(await combine(f250, bmw)).toMatchObject({ ok: true, status: 'completed' })
  return { f250, bmw, a: (await est(f250)).qbInvoiceId! }
}

describe('Kelvin: two completed Jobs combined — exact totals, combined fee lines, history preserved', () => {
  it('#A keeps both vehicles at $318.28 (balance $318.28), #B voided $0, each vehicle’s services separate, ONE shop-supplies and ONE card-fee line, each Job’s own fees intact', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const [a0, b0] = [await est(f250), await est(bmw)]
    expect([a0.totalCents, b0.totalCents]).toEqual([15914, 15914])   // the real #100922 / #100924 amounts
    const fees = async (id: string) => { const d = (await loadJobDraft(id)).draft!; return [d.workPriceCents, d.shopSupplies.cents, d.paymentCharge.cents, d.totalCents] }
    const [fa0, fb0] = [await fees(f250), await fees(bmw)]
    expect(fa0).toEqual([15000, 450, 464, 15914])
    const p = await previewCombineInvoices({ orderId: bmw, otherOrderId: f250 })
    expect(p).toMatchObject({ ok: true, combinedTotalCents: 31828, retained: { orderId: f250 }, replaced: { orderId: bmw } })
    expect(await combine(f250, bmw)).toMatchObject({ ok: true, status: 'completed', combinedTotalCents: 31828 })
    expect(qbCents(a0.qbInvoiceId)).toEqual({ total: 31828, balance: 31828 })
    expect(qbCents(b0.qbInvoiceId)).toEqual({ total: 0, balance: 0 })
    expect(lineView(a0.qbInvoiceId)).toEqual([
      '# Vehicle 1 of 2 — 2018 Ford F-250 · VIN 1FT7W2BT0JE000001', 'Full Detail 150',
      '# Vehicle 2 of 2 — 2022 BMW 330i · VIN WBA5R1C00NF000002', 'Full Detail 150',
      'Shop supplies 9', 'Card Payment 9.28',
    ])
    // Each Job's own fee calculation is unchanged (3% supplies, card fee on its own subtotal, own rounding).
    expect([await fees(f250), await fees(bmw)]).toEqual([fa0, fb0])
    expect(qb.calls.send).toBe(0)
  })
})

describe('third vehicle WITHOUT its own invoice joins the combined invoice (existing shared-invoice flow)', () => {
  for (const when of ['before completion', 'after completion'] as const) {
    it(`${when}: offered #A, linked, reviewed, updated — 3 vehicle sections, combined fees, total = Σ 3 Job totals; first two untouched`, async () => {
      const { f250, bmw, a } = await kelvinCombined()
      const bmwMember0 = (await members()).find((m) => m.memberServiceOrderId === bmw)!
      const third = await retailJob({ vehicle: TAHOE, work: 20000, status: when === 'before completion' ? 'in_progress' : 'ready', completedAt: when === 'after completion' ? new Date('2026-10-25T18:00:00Z') : undefined })
      const disc = await findSharedInvoiceCandidates(third)
      const c = disc.candidates.find((x) => x.invoiceId === a)!
      expect(c).toMatchObject({ eligible: true, anchorOrderId: f250, vehicles: ['2018 Ford F-250', '2022 BMW 330i'], totalCents: 31828 })
      expect((await linkToSharedInvoice({ orderId: third, anchorOrderId: f250, invoiceId: a, expectedSyncToken: c.syncToken, actor: 'Manager' })).ok).toBe(true)
      const rv = await previewSharedInvoiceUpdate(f250)
      const t3 = (await est(third)).totalCents
      expect(rv).toMatchObject({ ok: true, blockers: [], combinedTotalCents: 31828 + t3 })
      expect((await updateSharedInvoice({ orderId: f250, actor: 'Manager', expectedSyncToken: rv.syncToken! })).ok).toBe(true)
      expect(qbCents(a)).toEqual({ total: 31828 + t3, balance: 31828 + t3 })
      const lines = lineView(a)
      expect(lines.filter((l) => l.startsWith('# Vehicle'))).toEqual([
        '# Vehicle 1 of 3 — 2018 Ford F-250 · VIN 1FT7W2BT0JE000001', '# Vehicle 2 of 3 — 2022 BMW 330i · VIN WBA5R1C00NF000002', '# Vehicle 3 of 3 — 2020 Chevrolet Tahoe · VIN 1GNSKBKC0LR000003',
      ])
      expect(lines.filter((l) => /^Shop supplies/.test(l))).toHaveLength(1)
      expect(lines.filter((l) => /^Card Payment/.test(l))).toHaveLength(1)
      // The first two memberships are preserved exactly; the third is added once.
      const ms = await members()
      expect(ms.filter((m) => m.state === 'applied').map((m) => m.memberServiceOrderId).sort()).toEqual([bmw, third].sort())
      expect(ms.find((m) => m.id === bmwMember0.id)).toMatchObject({ state: 'applied', appliedAt: bmwMember0.appliedAt, appliedTotalCents: 15914 })
      expect(await est(third)).toMatchObject({ qbInvoiceId: null, qbStatus: 'linked' })
      expect((await order(third)).status).toBe(when === 'before completion' ? 'in_progress' : 'ready')
      expect(qb.calls).toMatchObject({ create: 2, void: 1, send: 0 })
    })
  }
})

describe('third vehicle WITH its own invoice is combined into the existing two-vehicle invoice', () => {
  async function thirdInvoiced(work = 20000) {
    const base = await kelvinCombined()
    const third = await retailJob({ vehicle: TAHOE, work, completedAt: new Date('2026-10-25T18:00:00Z') })
    expect((await createRetailQBInvoice({ orderId: third, actor: 'Manager' })).ok).toBe(true)
    return { ...base, third, c: (await est(third)).qbInvoiceId! }
  }

  it('offered from either side; #A (already shared) is always the one kept — even when the third invoice is emailed — and can’t be swapped away', async () => {
    const { f250, bmw, third, c } = await thirdInvoiced()
    expect((await findCombineCandidates(third)).candidates).toEqual([expect.objectContaining({ orderId: f250, eligible: true, totalCents: 31828 })])
    expect((await findCombineCandidates(f250)).candidates).toEqual([expect.objectContaining({ orderId: third, eligible: true })])
    expect(await findCombineCandidates(bmw)).toMatchObject({ ok: true, blocked: expect.stringMatching(/another vehicle’s shared invoice/) })
    inv(c).EmailStatus = 'EmailSent'   // would normally make it the one kept
    const p = await previewCombineInvoices({ orderId: third, otherOrderId: f250 })
    expect(p).toMatchObject({ ok: true, retained: { orderId: f250, vehicles: [{ vehicle: '2018 Ford F-250' }, { vehicle: '2022 BMW 330i' }] }, replaced: { orderId: third } })
    expect(p.plan!.join(' ')).toMatch(/all 3 vehicles/)
    expect(await previewCombineInvoices({ orderId: third, otherOrderId: f250, retainOrderId: third })).toMatchObject({ ok: false, error: expect.stringMatching(/already bills 2 vehicles .* must be the one kept/) })
  })

  it('combines: #C voided, #A bills 3 vehicles at Σ of the three Job totals, first two members untouched, third added once, nothing emailed', async () => {
    const { f250, bmw, a, third, c } = await thirdInvoiced()
    const bmwMember0 = (await members()).find((m) => m.memberServiceOrderId === bmw)!
    const totals = [(await est(f250)).totalCents, (await est(bmw)).totalCents, (await est(third)).totalCents]
    const sum = totals.reduce((x, y) => x + y, 0)
    const [o1, o2, o3] = [await order(f250), await order(bmw), await order(third)]
    const r = await combine(f250, third)
    expect(r).toMatchObject({ ok: true, status: 'completed', combinedTotalCents: sum })
    expect(qbCents(a)).toEqual({ total: sum, balance: sum })
    expect(qbCents(c)).toEqual({ total: 0, balance: 0 })
    expect(inv(c).PrivateNote).toMatch(/^Voided/)
    const lines = lineView(a)
    expect(lines.filter((l) => l.startsWith('# Vehicle')).map((l) => l.slice(0, 18))).toEqual(['# Vehicle 1 of 3 —', '# Vehicle 2 of 3 —', '# Vehicle 3 of 3 —'])
    expect(lines.filter((l) => /^Shop supplies/.test(l))).toHaveLength(1)
    expect(lines.filter((l) => /^Card Payment/.test(l))).toHaveLength(1)
    const ms = await members()
    expect(ms.filter((m) => m.state === 'applied').map((m) => m.memberServiceOrderId).sort()).toEqual([bmw, third].sort())
    expect(ms.find((m) => m.id === bmwMember0.id)).toMatchObject({ state: 'applied', appliedAt: bmwMember0.appliedAt, appliedTotalCents: totals[1] })
    expect(await est(third)).toMatchObject({ qbInvoiceId: null, qbStatus: 'linked' })
    const op = (await ops()).find((o) => o.replacedServiceOrderId === third)!
    expect(op).toMatchObject({ status: 'completed', retainedMemberCount: 1, retainedTotalCents: 31828 })
    for (const [before, id] of [[o1, f250], [o2, bmw], [o3, third]] as const) {
      const after = await order(id)
      expect(after.status).toBe(before.status)
      expect(after.completedAt?.toISOString()).toBe(before.completedAt?.toISOString())
    }
    expect(await events(third)).toEqual(expect.arrayContaining(['invoice_combine_voided', 'invoice_combine_completed']))
    expect(qb.calls).toMatchObject({ create: 3, void: 2, send: 0 })
    expect((await loadCombineState(third))?.summary).toMatch(/all 3 vehicles/)
    // Reports: each vehicle counted once; one open receivable.
    const rows = (await db.execute(sql`SELECT je.service_order_id AS id FROM job_estimates je
      WHERE je.qb_invoice_id IS NOT NULL OR EXISTS (SELECT 1 FROM retail_invoice_members rim WHERE rim.member_estimate_id = je.id AND rim.state = 'applied')`) as unknown as { rows: { id: string }[] }).rows
    expect(rows.map((x) => x.id).sort()).toEqual([f250, bmw, third].sort())
    expect([...qb.invoices.values()].filter((i) => i.Balance > 0)).toHaveLength(1)
  })

  it('a payment or credit applied to #A before the third vehicle arrives → both workflows refuse with the reason, nothing written', async () => {
    for (const mutate of [(x: { Balance: number }) => { x.Balance -= 50 }, (x: { LinkedTxn?: unknown[] }) => { x.LinkedTxn = [{ TxnId: '77', TxnType: 'CreditMemo' }] }]) {
      for (const t of ['retail_invoice_consolidations', 'retail_invoice_members', 'job_line_items', 'job_services', 'job_estimates', 'quick_entry_jobs', 'service_order_events', 'service_orders', 'vehicles']) await db.execute(sql.raw(`DELETE FROM ${t}`))
      qb.invoices.clear()
      const { f250, a, third } = await thirdInvoiced()
      const uninvoiced = await retailJob({ vehicle: { make: 'Toyota', model: 'Camry' }, work: 9000 })
      mutate(inv(a))
      const w0 = { ...qb.calls }
      expect((await findSharedInvoiceCandidates(uninvoiced)).candidates.find((x) => x.invoiceId === a)).toMatchObject({ eligible: false, reason: expect.stringMatching(/payment or credit/) })
      expect(await previewCombineInvoices({ orderId: third, otherOrderId: f250 })).toMatchObject({ ok: false, error: expect.stringMatching(/payment or credit/) })
      expect((await findCombineCandidates(third)).candidates[0]).toMatchObject({ eligible: false, reason: expect.stringMatching(/payment or credit/) })
      expect(qb.calls).toMatchObject({ create: w0.create, update: w0.update, void: w0.void, send: 0 })
      expect((await ops()).filter((o) => o.replacedServiceOrderId === third)).toHaveLength(0)
    }
  })

  it('a dealer Job is never offered and never combined into the shared invoice', async () => {
    const { f250, a } = await kelvinCombined()
    const dealer = await retailJob({ vehicle: TAHOE, work: 9000, source: 'dealer_checkin', serviceType: 'dealer' })
    expect((await findSharedInvoiceCandidates(dealer))).toMatchObject({ skipped: 'dealer', candidates: [] })
    expect(await previewCombineInvoices({ orderId: f250, otherOrderId: dealer })).toMatchObject({ ok: false, error: expect.stringMatching(/Dealer/) })
    expect((await findCombineCandidates(f250)).candidates.map((x) => x.orderId)).not.toContain(dealer)
    expect(qbCents(a).total).toBe(31828)
  })

  it('two invoices that each already bill several vehicles are never combined', async () => {
    const { f250, third } = await thirdInvoiced()
    const fourth = await retailJob({ vehicle: { make: 'Toyota', model: 'Camry' }, work: 9000 })
    const c = (await findSharedInvoiceCandidates(fourth)).candidates.find((x) => x.anchorOrderId === third)!
    await linkToSharedInvoice({ orderId: fourth, anchorOrderId: third, invoiceId: c.invoiceId, expectedSyncToken: c.syncToken, actor: 'M' })
    const rv = await previewSharedInvoiceUpdate(third)
    expect((await updateSharedInvoice({ orderId: third, actor: 'M', expectedSyncToken: rv.syncToken! })).ok).toBe(true)
    expect(await previewCombineInvoices({ orderId: third, otherOrderId: f250 })).toMatchObject({ ok: false, error: expect.stringMatching(/Both invoices already bill more than one vehicle/) })
  })

  it('another vehicle linked to #A after the claim (pending) → cancelled before the void; nothing voided or rewritten', async () => {
    const { f250, a, third, c } = await thirdInvoiced()
    const other = await retailJob({ vehicle: { make: 'Toyota', model: 'Camry' }, work: 9000 })
    const [anchorEst, otherEst] = [await est(f250), await getOrCreateEstimate(other, 'T')]
    const r = await withAfterClaim(async () => {
      await db.insert(retailInvoiceMembers).values({ anchorEstimateId: anchorEst.id, anchorServiceOrderId: f250, memberEstimateId: otherEst.id, memberServiceOrderId: other, qbInvoiceId: a, qbInvoiceNumber: anchorEst.qbInvoiceNumber, state: 'pending', linkRequestId: 'race', linkedBy: 'X' })
    }, () => combine(f250, third))
    expect(r).toMatchObject({ ok: false, block: 'stale', status: 'cancelled', error: expect.stringMatching(/vehicles on .* changed/) })
    expect(qb.calls.void).toBe(1)   // only the first combine's void
    expect(qbCents(c).total).toBeGreaterThan(0)
    expect(qbCents(a).total).toBe(31828)
    expect(await est(third)).toMatchObject({ qbInvoiceId: c, qbStatus: 'created' })
  })

  it('the vehicles on #A change between the final re-check and the claim → the claim statement refuses (busy), nothing written', async () => {
    const { f250, a, third, c } = await thirdInvoiced()
    const other = await retailJob({ vehicle: { make: 'Toyota', model: 'Camry' }, work: 9000 })
    const [anchorEst, otherEst] = [await est(f250), await getOrCreateEstimate(other, 'T')]
    const real = holder.db!
    let fired = false
    holder.db = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k)
        if (k !== 'execute') return typeof v === 'function' ? v.bind(t) : v
        return async (q: unknown) => {
          if (!fired && JSON.stringify(q).includes('INSERT INTO retail_invoice_consolidations')) {
            fired = true
            await real.insert(retailInvoiceMembers).values({ anchorEstimateId: anchorEst.id, anchorServiceOrderId: f250, memberEstimateId: otherEst.id, memberServiceOrderId: other, qbInvoiceId: a, qbInvoiceNumber: anchorEst.qbInvoiceNumber, state: 'applied', linkRequestId: 'race2', linkedBy: 'X' })
          }
          return (t as typeof real).execute(q as never)
        }
      },
    }) as typeof real
    let r
    try { r = await combine(f250, third) } finally { holder.db = real }
    expect(fired).toBe(true)
    expect(r).toMatchObject({ ok: false, block: 'busy' })
    expect((await ops()).filter((o) => o.replacedServiceOrderId === third)).toHaveLength(0)
    expect(await est(third)).toMatchObject({ qbInvoiceId: c, qbStatus: 'created' })
    expect(qb.calls.void).toBe(1)
  })

  it('every write boundary for the 3-vehicle combine recovers to exactly one update and Σ totals (void lost, update failed, update landed but lost)', async () => {
    for (const fault of ['void_lost', 'update_failed', 'update_landed_lost'] as const) {
      for (const t of ['retail_invoice_consolidations', 'retail_invoice_members', 'job_line_items', 'job_services', 'job_estimates', 'quick_entry_jobs', 'service_order_events', 'service_orders', 'vehicles']) await db.execute(sql.raw(`DELETE FROM ${t}`))
      qb.invoices.clear(); qb.voidMode = 'ok'
      const { f250, bmw, a, third, c } = await thirdInvoiced()
      const sum = 31828 + (await est(third)).totalCents
      if (fault === 'void_lost') qb.voidMode = 'lost_response'
      if (fault === 'update_failed') qb.beforeUpdate = async () => { throw new Error('ETIMEDOUT') }
      if (fault === 'update_landed_lost') qb.afterUpdate = async () => { throw new Error('socket hang up') }
      const first = await combine(f250, third)
      qb.voidMode = 'ok'
      let final = first
      if (!first.ok) {
        const rv = await previewSharedInvoiceUpdate(f250, { forCombine: true })
        final = await resumeCombineInvoices({ orderId: third, actor: 'M', expectedSyncToken: rv.ok ? rv.syncToken : null, combinedTotalCents: rv.ok ? rv.combinedTotalCents : null })
      }
      expect(final, fault).toMatchObject({ ok: true, status: 'completed' })
      expect(qbCents(a), fault).toEqual({ total: sum, balance: sum })
      expect(qbCents(c).total, fault).toBe(0)
      expect((await members()).filter((m) => m.state === 'applied').map((m) => m.memberServiceOrderId).sort(), fault).toEqual([bmw, third].sort())
      expect(qb.calls.send).toBe(0)
    }
  })
})

describe('review fix: an invoice emailed from QuickBooks mid-combine WITHOUT a SyncToken change still needs acknowledgement', () => {
  it('replaced invoice emailed after the review → no void until acknowledged (server-side); Retry with it voids, finishes and records it', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const b = inv((await est(bmw)).qbInvoiceId)
    const r = await withAfterClaim(() => { b.EmailStatus = 'EmailSent' }, () => combine(f250, bmw))
    expect(r).toMatchObject({ ok: false, block: 'confirm_required', status: 'prepared', error: expect.stringMatching(/emailed to the customer after this combine was reviewed/) })
    expect(qb.calls.void).toBe(0)
    expect(await loadCombineState(f250)).toMatchObject({ active: true, ackRequired: 'email' })
    // Retry without the acknowledgement still writes nothing.
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ block: 'confirm_required' })
    expect(qb.calls.void).toBe(0)
    const done = await resumeCombineInvoices({ orderId: bmw, actor: 'M', confirmSent: true })
    expect(done).toMatchObject({ ok: true, status: 'completed' })
    const op = (await ops())[0]
    expect(op).toMatchObject({ lateEmailAcknowledgedBy: 'M', ackRequired: null, lateEmailAcknowledgedInvoices: `#${op.replacedInvoiceNumber}` })
    for (const id of [f250, bmw]) expect(await events(id)).toContain('invoice_combine_email_acknowledged')
    expect(qb.calls.send).toBe(0)
  })
})

describe('independent review (2026-10-23) fixes', () => {
  it('acknowledgements are PER INVOICE: acknowledging #B’s late email does not cover #A being emailed later', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const [aId, bId] = [(await est(f250)).qbInvoiceId, (await est(bmw)).qbInvoiceId]
    qb.beforeUpdate = async () => { throw new Error('ETIMEDOUT') }
    expect(await withAfterClaim(() => { inv(bId).EmailStatus = 'EmailSent' }, () => combine(f250, bmw))).toMatchObject({ block: 'confirm_required', status: 'prepared' })
    // Acknowledge #B → void + relink, then the update times out.
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', confirmSent: true })).toMatchObject({ ok: false, status: 'relinked' })
    inv(aId).EmailStatus = 'EmailSent'   // #A emailed straight from QuickBooks afterwards
    const rv = await previewSharedInvoiceUpdate(f250, { forCombine: true })
    const u0 = qb.calls.update
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', expectedSyncToken: rv.syncToken })).toMatchObject({ ok: false, block: 'confirm_required', error: expect.stringMatching(new RegExp(`#${inv(aId).DocNumber} was emailed`)) })
    expect(qb.calls.update).toBe(u0)
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', expectedSyncToken: rv.syncToken, confirmSent: true })).toMatchObject({ ok: true, status: 'completed' })
    expect((await ops())[0].lateEmailAcknowledgedInvoices).toBe(`#${inv(bId).DocNumber},#${inv(aId).DocNumber}`)
    expect(qb.calls.send).toBe(0)
  })

  it('a void done in QuickBooks by someone else is recorded (never cancelled) but finishing needs an explicit payment check; Bill separately stays available', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    const bId = (await est(bmw)).qbInvoiceId
    const r = await withAfterClaim(() => { const b = inv(bId); Object.assign(b, { PrivateNote: 'Voided', TotalAmt: 0, Balance: 0, SyncToken: String(Number(b.SyncToken) + 1) }) }, () => combine(f250, bmw))
    expect(r).toMatchObject({ ok: false, block: 'confirm_required', status: 'voided', error: expect.stringMatching(/voided in QuickBooks outside this combine/) })
    expect(qb.calls.void).toBe(0)   // Pitt Stop never voided it
    expect(await loadCombineState(f250)).toMatchObject({ ackRequired: 'external_void', canCancel: false, canSeparate: true })
    expect(await cancelCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'not_allowed' })
    const u0 = qb.calls.update
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ ok: false, block: 'confirm_required', status: 'relinked' })
    expect(qb.calls.update).toBe(u0)
    // The EMAIL acknowledgement is not the payment check — it never satisfies it.
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', confirmSent: true })).toMatchObject({ ok: false, block: 'confirm_required' })
    expect(qb.calls.update).toBe(u0)
    expect(await resumeCombineInvoices({ orderId: bmw, actor: 'M', confirmExternalVoid: true })).toMatchObject({ ok: true, status: 'completed' })
    for (const id of [f250, bmw]) expect(await events(id)).toContain('invoice_combine_void_acknowledged')
  })

  it('an unclear (timed-out) update keeps Bill separately waiting; a definitive pre-write refusal does not', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.afterUpdate = async () => { throw new Error('socket hang up') }   // landed, response lost → ambiguous
    expect(await combine(f250, bmw)).toMatchObject({ ok: false, status: 'relinked' })
    expect((await ops())[0].updateAttemptedAt).not.toBeNull()
    expect(await separateCombineInvoices({ orderId: bmw, actor: 'M' })).toMatchObject({ block: 'busy' })
  })

  it('Cancel never half-commits: a replaced Job that is no longer "consolidating" keeps the combine prepared and reports not-ok', async () => {
    const { f250, bmw } = await kelvinTwoInvoices()
    qb.failRaw = 0
    const r = await withAfterClaim(() => { qb.failRaw = 5 }, () => combine(f250, bmw))   // QuickBooks unreachable → stays prepared
    expect(r).toMatchObject({ ok: false, status: 'prepared' })
    qb.failRaw = 0
    await db.update(jobEstimates).set({ qbStatus: 'created' }).where(eq(jobEstimates.serviceOrderId, bmw))   // out-of-band change
    const c = await cancelCombineInvoices({ orderId: bmw, actor: 'M' })
    expect(c.ok).toBe(false)
    expect((await ops())[0].status).toBe('prepared')
    expect((await members())[0].state).toBe('pending')
  })

  it('a void response with the marker but WITHOUT amounts is never a confirmed void', async () => {
    const { replacedVoidState } = await import('./invoice-consolidation')
    expect(replacedVoidState({ Id: '1', PrivateNote: 'Voided' } as never)).toBe('unconfirmed')
    expect(replacedVoidState({ Id: '1', PrivateNote: 'Voided', TotalAmt: 0, Balance: 0 } as never)).toBe('voided')
    expect(replacedVoidState({ Id: '1', PrivateNote: 'PSID:x', TotalAmt: 0 } as never)).toBe('live')
  })
})
