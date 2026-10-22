/**
 * Shared retail invoice — end to end on an in-memory PGlite (real schema, real partial unique index, real
 * data-modifying CTE locks) with the REAL pricing engine, Invoice Draft, Create / Sync / Send services. Only the
 * QuickBooks HTTP layer is a fake in-memory company. Nothing is ever emailed: the fake's send throws.
 *
 * Scenario: Kelvin Cooper's first vehicle has app-created invoice; his second vehicle arrives later.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

/* eslint-disable @typescript-eslint/no-explicit-any */
const qb = vi.hoisted(() => ({
  invoices: new Map<string, any>(),
  nextId: 500,
  customers: new Map<string, string>(),     // normalized email OR phone digits → QB customer id
  calls: { create: 0, update: 0, send: 0, list: 0, raw: 0 },
  failList: false,
  beforeUpdate: null as null | (() => Promise<void>),
  afterUpdate: null as null | (() => Promise<void>),
}))
const clone = <T>(x: T): T => (x == null ? x : JSON.parse(JSON.stringify(x)))
vi.mock('@/apps/quickbooks/retail-invoice-write', async () => {
  const plan = await import('./shared-invoice-plan')
  const { QBApiError } = await import('./errors')
  const toRaw = (lines: any[]) => lines.map((l) => (l.kind === 'text'
    ? { DetailType: 'DescriptionOnly', Description: l.description, DescriptionLineDetail: {} }
    : { DetailType: 'SalesItemLineDetail', Amount: l.amountCents / 100, Description: l.description, SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: 1, UnitPrice: l.amountCents / 100 } }))
  const sum = (lines: any[]) => lines.filter((l) => l.kind !== 'text').reduce((t: number, l: any) => t + l.amountCents, 0) / 100
  const summarize = (inv: any) => ({ invoiceId: inv.Id, invoiceNumber: inv.DocNumber, syncToken: inv.SyncToken, totalAmtCents: Math.round(inv.TotalAmt * 100), lineCount: inv.Line.filter((l: any) => l.DetailType === 'SalesItemLineDetail').length, linesFingerprint: plan.linesFingerprint(plan.linesFromRawInvoice(inv.Line)) })
  return {
    resolveRetailItems: async () => ({ labor: 'LABOR', fees: 'FEES' }),
    createRetailInvoiceInQB: async (p: any) => {
      qb.calls.create++
      const id = String(qb.nextId++)
      const inv = { Id: id, DocNumber: `10${id}`, SyncToken: '0', TotalAmt: sum(p.lines), Balance: sum(p.lines), EmailStatus: 'NotSet', CustomerRef: { value: p.customerId }, PrivateNote: p.privateNote, CustomerMemo: { value: p.customerMemo }, BillEmail: p.billEmail ? { Address: p.billEmail } : undefined, Line: toRaw(p.lines), TxnDate: '2026-10-20' }
      qb.invoices.set(id, inv)
      return summarize(inv)
    },
    updateRetailInvoiceInQB: async (p: any) => {
      if (qb.beforeUpdate) { const h = qb.beforeUpdate; qb.beforeUpdate = null; await h() }
      qb.calls.update++
      const inv = qb.invoices.get(p.current.Id)
      if (String(p.current.SyncToken) !== String(inv.SyncToken)) throw new QBApiError(409, 'Stale Object Error')
      Object.assign(inv, { Line: toRaw(p.lines), PrivateNote: p.privateNote, CustomerMemo: { value: p.customerMemo }, TotalAmt: sum(p.lines), Balance: sum(p.lines), SyncToken: String(Number(inv.SyncToken) + 1) })
      // The QuickBooks write has LANDED here. A hook simulates work (or a crash) that happens AFTER QuickBooks
      // succeeds but BEFORE syncRetailQBInvoice finalizes membership — the exact window the recovery defect is about.
      if (qb.afterUpdate) { const h = qb.afterUpdate; qb.afterUpdate = null; await h() }
      return summarize(inv)
    },
    getRetailInvoiceRaw: async (id: string) => { qb.calls.raw++; return clone(qb.invoices.get(String(id)) ?? null) },
    listRetailInvoicesForCustomer: async (cid: string) => {
      qb.calls.list++
      if (qb.failList) throw new Error('QuickBooks is unavailable')
      return [...qb.invoices.values()].filter((i) => i.CustomerRef.value === cid).map(clone)
    },
    findRetailInvoiceByPsid: async (cid: string, estId: string) => {
      const inv = [...qb.invoices.values()].find((i) => i.CustomerRef.value === cid && String(i.PrivateNote ?? '').includes(`PSID:${estId}`))
      return inv ? summarize(inv) : null
    },
    sendRetailInvoiceInQB: async () => { qb.calls.send++; throw new Error('TEST: an invoice must never be emailed') },
    fillRetailInvoiceEmail: async () => { throw new Error('TEST: no email fill expected') },
  }
})
// The catalog → QuickBooks item map reads live QB items; no catalog here → every service bills as Labor.
vi.mock('@/apps/quickbooks/retail-item-map', () => ({
  loadRetailItemIndex: async () => {
    const none = { itemRef: null, itemName: 'Labor', usable: false, description: null }
    return { match: () => none, matchService: () => none, partsItem: () => null }
  },
}))
// Payment reads: no payments recorded against any fake invoice. Writes are never expected here.
vi.mock('@/apps/quickbooks/retail-payment-write', async (orig) => ({
  ...(await orig<typeof import('./retail-payment-write')>()),
  connectedRealmId: async () => 'sandbox-realm',
  getQbPayment: async () => null,
  loadInvoicePayments: async () => [],
  createRetailPaymentInQB: async () => { throw new Error('payment write not expected in shared-invoice tests') },
}))
const key = (c: { email?: string | null; phone?: string | null }) => [c.email?.trim().toLowerCase(), (c.phone ?? '').replace(/\D/g, '')].filter(Boolean)
const lookup = (c: { email?: string | null; phone?: string | null }) => { for (const k of key(c)) { const id = qb.customers.get(k!); if (id) return id } return null }
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

import { serviceOrders, vehicles, jobEstimates, retailInvoiceMembers, serviceOrderEvents } from '@/drizzle/schema'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { getOrCreateEstimate, setExplicitPrice, recomputeEstimate, getEstimateRow, flagQbSyncNeededIfInvoiced, setEstimateWaiver } from '@/apps/workflow/estimate-db'
import { createRetailQBInvoice, resolveRetailSend, sendRetailQBInvoice, syncRetailQBInvoice } from './retail-invoice-service'
import { findSharedInvoiceCandidates, linkToSharedInvoice, unlinkSharedInvoiceMember, previewSharedInvoiceUpdate, updateSharedInvoice, loadSharedInvoiceState } from './shared-invoice'
import { planOrderRemoval, executeOrderRemoval } from '@/apps/workflow/order-removal'
import { previewRetailPayment } from './retail-payment-service'

let db: PgliteDatabase<typeof schema>
let seq = 0

async function retailJob(o: { name: string; email?: string | null; phone?: string | null; vehicle: { year?: string; make: string; model: string; vin?: string }; work: number; source?: string; serviceType?: string; status?: string; completedAt?: Date }): Promise<string> {
  const [v] = await db.insert(vehicles).values({ year: o.vehicle.year ?? null, make: o.vehicle.make, model: o.vehicle.model, vin: o.vehicle.vin ?? null }).returning()
  const [so] = await db.insert(serviceOrders).values({ orderNumber: `SH-${++seq}`, vehicleId: v.id, source: o.source ?? 'quick_entry', serviceType: o.serviceType ?? 'retail', status: o.status ?? 'ready', customerName: o.name, services: ['Full Detail'], completedAt: o.completedAt ?? null }).returning()
  await db.insert(quickEntryJobs).values({ serviceOrderId: so.id, customerName: o.name, customerEmail: o.email ?? null, customerPhone: o.phone ?? null })
  const est = await getOrCreateEstimate(so.id, 'T')
  await setExplicitPrice(est.id, o.work, 'T')
  await recomputeEstimate(est.id)
  return so.id
}
const est = async (orderId: string) => (await getEstimateRow(orderId))!
const events = async (orderId: string) => (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))).map((e) => e.eventType)
const members = async () => db.select().from(retailInvoiceMembers)
const invoiceOf = async (orderId: string) => qb.invoices.get(String((await est(orderId)).qbInvoiceId))

const KELVIN = { name: 'Kelvin Cooper', email: 'kelvin@example.org', phone: '9795550101' }
async function kelvinWithInvoice(work = 21000, completedAt?: Date) {
  const a = await retailJob({ ...KELVIN, vehicle: { year: '2019', make: 'Honda', model: 'Civic', vin: '1HGCV1F30KA000001' }, work, completedAt })
  const c = await createRetailQBInvoice({ orderId: a, actor: 'Manager' })
  expect(c).toMatchObject({ ok: true })
  return a
}
const secondVehicle = (work = 15000, extra: Partial<Parameters<typeof retailJob>[0]> = {}) =>
  retailJob({ ...KELVIN, vehicle: { year: '2018', make: 'Ford', model: 'F-150' }, work, ...extra })

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST-ONLY db wrapper (no production seam): wrap the first `jobEstimates` UPDATE whose `.set(values)` matches
 * `match`, and run `hook.before` just before — or `hook.after` just after — that UPDATE executes, before the
 * caller's `await` continues. Lets a test inject a link/unlink at a precise point inside a service call. Every
 * other db method is forwarded untouched to the real connection.
 */
function dbWithUpdateHook(real: any, match: (values: any) => boolean, hook: { before?: () => Promise<void>; after?: () => Promise<void> }): any {
  let armed = true
  const wrap = (q: any): any => new Proxy(q, {
    get(target, prop) {
      if (prop === 'then') return (onF: any, onR: any) => (async () => {
        if (hook.before) await hook.before()
        const r = await target
        if (hook.after) await hook.after()
        return r
      })().then(onF, onR)
      const v = Reflect.get(target, prop)
      if (typeof v !== 'function') return v
      return (...args: any[]) => { const res = v.apply(target, args); return res === target ? wrap(target) : res }   // keep chaining (.where/.returning) wrapped
    },
  })
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'update') return (table: any) => {
        const builder = target.update(table)
        const origSet = builder.set.bind(builder)
        builder.set = (values: any) => { const q = origSet(values); if (armed && match(values)) { armed = false; return wrap(q) } return q }
        return builder
      }
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema }); holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]); await apply()
})
beforeEach(async () => {
  for (const t of ['retail_invoice_members', 'job_line_items', 'job_services', 'job_estimates', 'quick_entry_jobs', 'service_order_events', 'service_orders', 'vehicles']) await db.execute(`DELETE FROM ${t}`)
  qb.invoices.clear(); qb.customers.clear(); qb.failList = false; qb.beforeUpdate = null; qb.afterUpdate = null
  qb.calls = { create: 0, update: 0, send: 0, list: 0, raw: 0 }
  qb.customers.set(KELVIN.email, 'C-KELVIN'); qb.customers.set(KELVIN.phone, 'C-KELVIN')
  qb.customers.set('other@example.org', 'C-OTHER')
})

describe('discovery (after the second vehicle is saved through normal intake)', () => {
  it('finds Kelvin’s open app-created invoice: number, vehicle, balance, emailed state', async () => {
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    const d = await findSharedInvoiceCandidates(b)
    expect(d).toMatchObject({ ok: true, customerName: 'Kelvin Cooper', vehicle: '2018 Ford F-150' })
    expect(d.candidates).toHaveLength(1)
    const c = d.candidates[0]
    expect(c).toMatchObject({ eligible: true, anchorOrderId: a, invoiceNumber: (await est(a)).qbInvoiceNumber, vehicles: ['2019 Honda Civic'], emailed: false })
    expect(c.balanceCents).toBe((await est(a)).totalCents)
    expect(qb.calls.update + qb.calls.create).toBe(1)   // only the anchor's original Create — discovery wrote nothing
  })

  it('several open invoices → all offered so the manager chooses', async () => {
    await kelvinWithInvoice()
    const a2 = await retailJob({ ...KELVIN, vehicle: { make: 'Toyota', model: 'Camry' }, work: 9000 })
    expect((await createRetailQBInvoice({ orderId: a2, actor: 'M' })).ok).toBe(true)
    const d = await findSharedInvoiceCandidates(await secondVehicle())
    expect(d.candidates.filter((c) => c.eligible)).toHaveLength(2)
  })

  it('dealer Job → skipped before ANY customer or QuickBooks lookup', async () => {
    await kelvinWithInvoice()
    const raw0 = qb.calls.raw
    const dealer = await retailJob({ ...KELVIN, vehicle: { make: 'Ford', model: 'Escape' }, work: 9000, source: 'dealer_checkin', serviceType: 'dealer_detail' })
    const d = await findSharedInvoiceCandidates(dealer)
    expect(d).toMatchObject({ ok: true, skipped: 'dealer', candidates: [] })
    expect(qb.calls.list).toBe(0); expect(qb.calls.raw).toBe(raw0)
    // …and linking is refused server-side even if called directly.
    const a = (await db.select().from(serviceOrders).where(eq(serviceOrders.customerName, 'Kelvin Cooper')))[0].id
    const r = await linkToSharedInvoice({ orderId: dealer, anchorOrderId: a, invoiceId: String((await est(a)).qbInvoiceId), actor: 'M' })
    expect(r).toMatchObject({ ok: false, block: 'dealer' })
    expect(await members()).toHaveLength(0)
  })

  it('dealer invoices are never candidates for a retail Job', async () => {
    const dealerAnchor = await retailJob({ ...KELVIN, vehicle: { make: 'Ford', model: 'Escape' }, work: 9000, source: 'dealer_checkin', serviceType: 'dealer_detail' })
    // Even if a dealer row somehow carried a retail invoice id for this customer:
    qb.invoices.set('900', { Id: '900', DocNumber: '900', SyncToken: '0', TotalAmt: 90, Balance: 90, CustomerRef: { value: 'C-KELVIN' }, PrivateNote: `PSID:${(await est(dealerAnchor)).id}`, Line: [] })
    await db.update(jobEstimates).set({ qbInvoiceId: '900', qbStatus: 'created' }).where(eq(jobEstimates.serviceOrderId, dealerAnchor))
    const d = await findSharedInvoiceCandidates(await secondVehicle())
    expect(d.candidates).toHaveLength(0)
  })

  it('name only (no email / phone) → never matched by name', async () => {
    await kelvinWithInvoice()
    const b = await retailJob({ name: 'Kelvin Cooper', vehicle: { make: 'Ford', model: 'F-150' }, work: 15000 })
    const d = await findSharedInvoiceCandidates(b)
    expect(d).toMatchObject({ ok: true, skipped: 'no_confirmed_customer', candidates: [] })
    expect(qb.calls.list).toBe(0)
  })

  it('a different confirmed customer with the same name sees nothing', async () => {
    await kelvinWithInvoice()
    const b = await retailJob({ name: 'Kelvin Cooper', email: 'other@example.org', vehicle: { make: 'Ford', model: 'F-150' }, work: 15000 })
    expect((await findSharedInvoiceCandidates(b)).candidates).toHaveLength(0)
  })

  it('paid, partially paid, voided, or edited-in-QuickBooks invoices are shown as not eligible', async () => {
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    const inv = await invoiceOf(a)
    for (const [mutate, reason] of [
      [() => { inv.Balance = inv.TotalAmt - 10 }, /payment or credit/],
      [() => { inv.Balance = 0 }, /paid/],
      [() => { inv.TotalAmt = 0; inv.Balance = 0 }, /voided/],
      [() => { inv.Line.push({ DetailType: 'SalesItemLineDetail', Amount: 0, Description: 'Note added in QB', SalesItemLineDetail: { ItemRef: { value: '1' } } }) }, /changed in QuickBooks/],
    ] as const) {
      const snapshot = clone(inv)
      ;(mutate as () => void)()
      const c = (await findSharedInvoiceCandidates(b)).candidates[0]
      expect(c.eligible).toBe(false)
      expect(c.reason).toMatch(reason)
      Object.keys(inv).forEach((k) => delete inv[k]); Object.assign(inv, snapshot)
    }
  })

  it('a local payment / needs-review / sync-needed anchor is not eligible', async () => {
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    await db.update(jobEstimates).set({ qbPaymentStatus: 'recorded' }).where(eq(jobEstimates.serviceOrderId, a))
    expect((await findSharedInvoiceCandidates(b)).candidates[0].eligible).toBe(false)
    await db.update(jobEstimates).set({ qbPaymentStatus: 'none', qbSyncError: 'QuickBooks sync needed — a price changed.' }).where(eq(jobEstimates.serviceOrderId, a))
    expect((await findSharedInvoiceCandidates(b)).candidates[0].reason).toMatch(/sync/)
  })

  it('lookup failure → ok:false with a retry message; the saved Job is untouched', async () => {
    await kelvinWithInvoice()
    const b = await secondVehicle()
    const before = await est(b)
    qb.failList = true
    const d = await findSharedInvoiceCandidates(b)
    expect(d.ok).toBe(false)
    expect(d.error).toMatch(/Job is saved/)
    expect(await est(b)).toEqual(before)
  })

  it('a Job that already has its own invoice → reconciliation required, never merged', async () => {
    await kelvinWithInvoice()
    const b = await secondVehicle()
    expect((await createRetailQBInvoice({ orderId: b, actor: 'M' })).ok).toBe(true)
    const d = await findSharedInvoiceCandidates(b)
    expect(d).toMatchObject({ skipped: 'has_invoice' })
    expect(d.message).toMatch(/never merged automatically/)
  })
})

describe('link', () => {
  it('links as PENDING: no QuickBooks write, both Jobs audited, member can no longer Create its own invoice', async () => {
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    const c = (await findSharedInvoiceCandidates(b)).candidates[0]
    const writes = qb.calls.update + qb.calls.create
    const r = await linkToSharedInvoice({ orderId: b, anchorOrderId: a, invoiceId: c.invoiceId, expectedSyncToken: c.syncToken, requestId: 'req-1', actor: 'Manager' })
    expect(r).toMatchObject({ ok: true, anchorOrderId: a })
    expect(qb.calls.update + qb.calls.create).toBe(writes)
    const [m] = await members()
    expect(m).toMatchObject({ state: 'pending', anchorServiceOrderId: a, memberServiceOrderId: b, qbInvoiceId: c.invoiceId, linkedBy: 'Manager', linkRequestId: 'req-1' })
    expect((await est(b))).toMatchObject({ qbStatus: 'linked', qbInvoiceId: null })
    expect(await events(b)).toContain('shared_invoice_linked')
    expect(await events(a)).toContain('shared_invoice_member_added')
    // Prevent a standalone invoice for the linked Job.
    const cr = await createRetailQBInvoice({ orderId: b, actor: 'M' })
    expect(cr).toMatchObject({ ok: false, status: 'refused' })
    expect(cr.error).toMatch(/shared invoice/)
    expect(qb.invoices.size).toBe(1)
    // Both sides show the shared invoice.
    expect(await loadSharedInvoiceState(a)).toMatchObject({ role: 'anchor', pendingCount: 1, invoiceId: c.invoiceId })
    expect(await loadSharedInvoiceState(b)).toMatchObject({ role: 'member', memberState: 'pending', anchorOrderId: a })
  })

  it('double tap and concurrent links → exactly one membership; replay returns alreadyLinked', async () => {
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    const c = (await findSharedInvoiceCandidates(b)).candidates[0]
    const args = { orderId: b, anchorOrderId: a, invoiceId: c.invoiceId, expectedSyncToken: c.syncToken, actor: 'M' }
    const rs = await Promise.all([linkToSharedInvoice(args), linkToSharedInvoice(args), linkToSharedInvoice(args)])
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(await members()).toHaveLength(1)
    expect(await linkToSharedInvoice(args)).toMatchObject({ ok: true, alreadyLinked: true })
  })

  it('link racing the member’s own Create: exactly one wins, never both', async () => {
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    const c = (await findSharedInvoiceCandidates(b)).candidates[0]
    const [link, create] = await Promise.all([
      linkToSharedInvoice({ orderId: b, anchorOrderId: a, invoiceId: c.invoiceId, expectedSyncToken: c.syncToken, actor: 'M' }),
      createRetailQBInvoice({ orderId: b, actor: 'M' }),
    ])
    expect(Number(link.ok) + Number(create.ok)).toBe(1)
    const e = await est(b)
    expect(!!e.qbInvoiceId !== (e.qbStatus === 'linked')).toBe(true)
  })

  it('refuses when the invoice changed after the offer (stale SyncToken) or money was applied since', async () => {
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    const c = (await findSharedInvoiceCandidates(b)).candidates[0]
    const inv = await invoiceOf(a)
    inv.SyncToken = '7'
    expect(await linkToSharedInvoice({ orderId: b, anchorOrderId: a, invoiceId: c.invoiceId, expectedSyncToken: c.syncToken, actor: 'M' })).toMatchObject({ ok: false, block: 'stale' })
    inv.Balance = inv.TotalAmt / 2
    expect(await linkToSharedInvoice({ orderId: b, anchorOrderId: a, invoiceId: c.invoiceId, expectedSyncToken: '7', actor: 'M' })).toMatchObject({ ok: false, block: 'ineligible' })
    expect(await members()).toHaveLength(0)
    expect((await est(b)).qbStatus).toBe('none')
  })

  it('a member whose earlier Create failed but landed in QuickBooks (orphan) is refused', async () => {
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    const eb = await est(b)
    qb.invoices.set('777', { Id: '777', DocNumber: '777', SyncToken: '0', TotalAmt: 10, Balance: 10, CustomerRef: { value: 'C-KELVIN' }, PrivateNote: `PSID:${eb.id}`, Line: [] })
    await db.update(jobEstimates).set({ qbStatus: 'error', qbSyncError: 'timeout' }).where(eq(jobEstimates.id, eb.id))
    const inv = await invoiceOf(a)
    const r = await linkToSharedInvoice({ orderId: b, anchorOrderId: a, invoiceId: inv.Id, expectedSyncToken: inv.SyncToken, actor: 'M' })
    expect(r).toMatchObject({ ok: false, block: 'has_invoice' })
  })
})

async function linkedPair(opts: { work?: number; workB?: number; completedAt?: Date } = {}) {
  const a = await kelvinWithInvoice(opts.work ?? 21000, opts.completedAt)
  const b = await secondVehicle(opts.workB ?? 15000)
  const c = (await findSharedInvoiceCandidates(b)).candidates[0]
  expect((await linkToSharedInvoice({ orderId: b, anchorOrderId: a, invoiceId: c.invoiceId, expectedSyncToken: c.syncToken, actor: 'M' })).ok).toBe(true)
  return { a, b }
}

describe('while charges are pending review', () => {
  it('Send of the stale invoice is blocked (nothing emailed); Record Payment waits too', async () => {
    const { a } = await linkedPair()
    expect(await resolveRetailSend(a)).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(await sendRetailQBInvoice({ orderId: a, actor: 'M' })).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(await previewRetailPayment({ orderId: a, actor: 'M' })).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(qb.calls.send).toBe(0)
  })

  it('a member that links AFTER the send precheck but before the lock is caught under the lock — the invoice is never emailed', async () => {
    // No member is linked when Send starts (precheck passes). The link lands right as the 'sending' lock is taken
    // (anchor still 'created', so link is allowed). The re-read UNDER the lock must then refuse before any external
    // write — without it, the old order would reach the fake send (which throws "must never be emailed").
    const a = await kelvinWithInvoice()
    const b = await secondVehicle()
    const c = (await findSharedInvoiceCandidates(b)).candidates[0]
    const real = holder.db!
    holder.db = dbWithUpdateHook(real, (v) => v != null && v.qbStatus === 'sending',
      { before: async () => { await linkToSharedInvoice({ orderId: b, anchorOrderId: a, invoiceId: c.invoiceId, expectedSyncToken: c.syncToken, actor: 'M' }) } }) as typeof db
    let r: Awaited<ReturnType<typeof sendRetailQBInvoice>>
    try { r = await sendRetailQBInvoice({ orderId: a, actor: 'M' }) } finally { holder.db = real }
    expect(r).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(qb.calls.send).toBe(0)                                    // the fake send was never reached
    expect((await members())[0].state).toBe('pending')              // b linked, still pending
    expect((await est(a)).qbStatus).toBe('created')                 // lock released to prior status, not stuck 'sending'
  })

  it('an ordinary anchor Sync is REFUSED while a member is pending (it must never strip not-yet-reviewed charges)', async () => {
    const { a, b } = await linkedPair()
    const before = clone(await invoiceOf(a))
    await setEstimateWaiver((await est(a)).id, 'payment', true); await recomputeEstimate((await est(a)).id)
    await flagQbSyncNeededIfInvoiced(a, 'a charge changed')
    const r = await syncRetailQBInvoice({ orderId: a, actor: 'M' })   // plain Sync, not the reviewed Update invoice (applyPending)
    expect(r).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(qb.calls.update).toBe(0)
    expect(await invoiceOf(a)).toEqual(before)                        // nothing written or stripped in QuickBooks
    expect((await members())[0].state).toBe('pending')
    expect((await est(a)).qbStatus).toBe('created')                  // lock released back to its prior settled state
    expect(await loadSharedInvoiceState(b)).toMatchObject({ memberState: 'pending' })
  })

  it('Keep separate (unlink) → back to normal billing; the Job can then Create its own invoice', async () => {
    const { b } = await linkedPair()
    expect(await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' })).toEqual({ ok: true })
    expect((await est(b)).qbStatus).toBe('none')
    expect((await members())[0]).toMatchObject({ state: 'removed', removedBy: 'M' })
    expect(await events(b)).toContain('shared_invoice_unlinked')
    expect(await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' })).toEqual({ ok: true })   // idempotent
    expect((await createRetailQBInvoice({ orderId: b, actor: 'M' })).ok).toBe(true)
    expect(qb.invoices.size).toBe(2)
  })

  it('Work Board removal is refused for both Jobs (charges would be stranded)', async () => {
    const { a, b } = await linkedPair()
    await db.update(serviceOrders).set({ status: 'in_progress' })
    expect((await planOrderRemoval(b)).preview).toMatchObject({ kind: 'shared_invoice', blocked: true })
    expect((await planOrderRemoval(a)).preview).toMatchObject({ kind: 'shared_invoice', blocked: true })
    expect(await executeOrderRemoval({ orderId: b, actor: 'M' })).toMatchObject({ ok: false, block: 'not_eligible' })
    expect((await db.select().from(serviceOrders).where(eq(serviceOrders.id, b)))[0].status).toBe('in_progress')
  })
})

describe('review + update the SAME invoice', () => {
  it('preview shows each vehicle’s own breakdown and the combined total; nothing is written', async () => {
    const { a, b } = await linkedPair()
    const before = clone(await invoiceOf(a))
    const p = await previewSharedInvoiceUpdate(b)   // callable from the member side too
    expect(p.ok).toBe(true)
    expect(p.parts!.map((x) => [x.vehicle, x.state])).toEqual([['2019 Honda Civic', 'anchor'], ['2018 Ford F-150', 'pending']])
    expect(p.combinedTotalCents).toBe((await est(a)).totalCents + (await est(b)).totalCents)
    expect(p.parts![1]).toMatchObject({ workPriceCents: 15000, shopSuppliesCents: 450, paymentChargeCents: 464, totalCents: 15914 })
    expect(p.blockers).toEqual([])
    expect(p.emailed).toBe(false)
    expect(await invoiceOf(a)).toEqual(before)
  })

  it('update requires the reviewed version; a stale review writes nothing', async () => {
    const { a, b } = await linkedPair()
    expect(await updateSharedInvoice({ orderId: b, actor: 'M' })).toMatchObject({ ok: false, block: 'stale' })
    const p = await previewSharedInvoiceUpdate(b)
    ;(await invoiceOf(a)).SyncToken = '9'       // someone touched it in QuickBooks after the review
    const r = await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })
    expect(r).toMatchObject({ ok: false, block: 'stale' })
    expect(qb.calls.update).toBe(0)
    expect((await est(a)).qbStatus).toBe('created')    // lock released, state untouched
    expect((await members())[0].state).toBe('pending')
  })

  it('writes both vehicles onto the SAME invoice: exact combined total, per-vehicle headers, member applied, never sent', async () => {
    const completedAt = new Date('2026-10-18T15:00:00.000Z')
    const { a, b } = await linkedPair({ completedAt })
    const invoiceId = (await est(a)).qbInvoiceId
    const p = await previewSharedInvoiceUpdate(a)
    const r = await updateSharedInvoice({ orderId: a, actor: 'Manager', expectedSyncToken: p.syncToken })
    expect(r).toMatchObject({ ok: true, appliedOrderIds: [b] })
    expect(qb.invoices.size).toBe(1)
    const inv = qb.invoices.get(String(invoiceId))
    const ea = await est(a), eb = await est(b)
    expect(Math.round(inv.TotalAmt * 100)).toBe(ea.totalCents + eb.totalCents)
    expect(inv.Line.filter((l: { DetailType: string }) => l.DetailType === 'DescriptionOnly').map((l: { Description: string }) => l.Description))
      .toEqual(['Vehicle 1 of 2 — 2019 Honda Civic · VIN 1HGCV1F30KA000001', 'Vehicle 2 of 2 — 2018 Ford F-150'])
    expect(inv.PrivateNote).toBe(`PSID:${ea.id} | PSLINK:${eb.id}`)
    expect((await members())[0]).toMatchObject({ state: 'applied', appliedTotalCents: eb.totalCents, appliedBy: 'Manager' })
    expect(eb).toMatchObject({ qbStatus: 'linked', qbInvoiceId: null })   // still no invoice of its own
    expect(ea.qbLinesFingerprint).toBeTruthy()
    expect(await events(b)).toContain('shared_invoice_applied')
    expect(await events(a)).toContain('shared_invoice_updated')
    expect(qb.calls.send).toBe(0)
    // Completion is independent: the original completion date never moves.
    expect((await db.select().from(serviceOrders).where(eq(serviceOrders.id, a)))[0].completedAt?.toISOString()).toBe(completedAt.toISOString())
    // Now current: Send verifies against the COMBINED total (resolution only — the fake would refuse to email).
    expect(await resolveRetailSend(a)).toMatchObject({ ok: true, draftTotalCents: ea.totalCents + eb.totalCents, qbTotalCents: ea.totalCents + eb.totalCents })
    // A repeat update is a no-op (idempotent retry).
    const again = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: (await previewSharedInvoiceUpdate(a)).syncToken })
    expect(again).toMatchObject({ ok: true, noop: true })
    expect(qb.calls.update).toBe(1)
  })

  it('double tap / concurrent updates → one QuickBooks write', async () => {
    const { b } = await linkedPair()
    const p = await previewSharedInvoiceUpdate(b)
    const rs = await Promise.all([1, 2, 3].map(() => updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })))
    expect(rs.filter((r) => r.ok && !r.noop)).toHaveLength(1)
    expect(qb.calls.update).toBe(1)
    expect((await members())[0].state).toBe('applied')
  })

  it('already-emailed invoice: requires deliberate confirmation, updates the SAME invoice, flags Resend recommended, never resends', async () => {
    const { a, b } = await linkedPair()
    const inv = await invoiceOf(a)
    inv.EmailStatus = 'EmailSent'
    await db.update(jobEstimates).set({ qbStatus: 'sent', qbSentAt: new Date() }).where(eq(jobEstimates.serviceOrderId, a))
    const p = await previewSharedInvoiceUpdate(b)
    expect(p.emailed).toBe(true)
    expect(await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })).toMatchObject({ ok: false, block: 'confirm_required' })
    expect(qb.calls.update).toBe(0)
    const r = await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken, confirmSent: true })
    expect(r.ok).toBe(true)
    expect(await est(a)).toMatchObject({ qbStatus: 'sent', qbSyncError: 'Resend recommended — invoice changed after it was emailed' })
    expect(qb.calls.send).toBe(0)
  })

  it('a payment applied in QuickBooks after discovery → refused, member stays pending, nothing written', async () => {
    const { a, b } = await linkedPair()
    const p = await previewSharedInvoiceUpdate(b)
    const inv = await invoiceOf(a)
    inv.Balance = inv.TotalAmt - 50
    const r = await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })
    expect(r).toMatchObject({ ok: false, block: 'paid', needsReview: true })
    expect(qb.calls.update).toBe(0)
    expect((await members())[0].state).toBe('pending')
    // The refusal left the anchor with a "Needs review" flag, so keep-separate is now refused too — a structural
    // change is never made while the invoice needs review; resolve the invoice first.
    expect(await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' })).toMatchObject({ ok: false })
  })

  it('lines edited in QuickBooks after linking → needs review, unrelated lines never overwritten', async () => {
    const { a, b } = await linkedPair()
    const inv = await invoiceOf(a)
    inv.Line.push({ DetailType: 'SalesItemLineDetail', Amount: 0, Description: 'Added by the bookkeeper', SalesItemLineDetail: { ItemRef: { value: '3' } } })
    const p = await previewSharedInvoiceUpdate(b)
    expect(p.blockers!.join(' ')).toMatch(/changed in QuickBooks/)
    const r = await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })
    expect(r).toMatchObject({ ok: false, block: 'lines_changed' })
    expect(qb.calls.update).toBe(0)
    expect((await invoiceOf(a)).Line.at(-1).Description).toBe('Added by the bookkeeper')
  })

  it('the linked vehicle’s customer changed → refused without touching the anchor’s invoice state', async () => {
    const { a, b } = await linkedPair()
    await db.update(quickEntryJobs).set({ customerEmail: 'other@example.org', customerPhone: null }).where(eq(quickEntryJobs.serviceOrderId, b))
    const p = await previewSharedInvoiceUpdate(b)
    expect(p.blockers!.join(' ')).toMatch(/no longer matches/)
    const r = await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })
    expect(r).toMatchObject({ ok: false, block: 'member_customer_mismatch', memberOrderId: b })
    expect(await est(a)).toMatchObject({ qbStatus: 'created', qbSyncError: null })
  })

  it('an unpriced linked vehicle blocks the update until its charges are finalized', async () => {
    const { b } = await linkedPair()
    await setExplicitPrice((await est(b)).id, 0, 'M'); await recomputeEstimate((await est(b)).id)
    const p = await previewSharedInvoiceUpdate(b)
    expect(p.blockers!.join(' ')).toMatch(/Work Price/)
    expect((await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })).block).toBe('member_unready')
    expect(qb.calls.update).toBe(0)
  })

  it('unlinking races an in-flight update: the member is either fully applied or fully separate', async () => {
    const { b } = await linkedPair()
    const p = await previewSharedInvoiceUpdate(b)
    let unlink: Awaited<ReturnType<typeof unlinkSharedInvoiceMember>> | null = null
    qb.beforeUpdate = async () => { unlink = await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' }) }   // while the Sync lock is held
    const r = await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })
    expect(r.ok).toBe(true)
    expect(unlink).toMatchObject({ ok: false, block: 'busy' })
    expect((await members())[0].state).toBe('applied')
    expect(await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' })).toMatchObject({ ok: false, block: 'applied' })
  })

  it('money applied at an EQUAL balance (linked payment / credit), a voided total, or a missing balance → refused; member stays pending, nothing written', async () => {
    // The old final check was Balance < TotalAmt only. These four all keep (or drop) the balance so that check
    // passes — the shared write must rerun the full money state and fail closed on each.
    const mutations: Array<(i: Record<string, unknown>) => void> = [
      (i) => { i.LinkedTxn = [{ TxnType: 'Payment' }] },      // a payment is linked even though Balance === TotalAmt
      (i) => { i.LinkedTxn = [{ TxnType: 'CreditMemo' }] },   // a credit is linked at full balance
      (i) => { i.TotalAmt = 0; i.Balance = 0 },               // voided / emptied in QuickBooks
      (i) => { i.Balance = undefined },                       // QuickBooks reported no balance at all
    ]
    const { a, b } = await linkedPair()
    const p = await previewSharedInvoiceUpdate(b)
    const inv = await invoiceOf(a)
    const snapshot = clone(inv)
    for (const mutate of mutations) {
      mutate(inv)
      const r = await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })
      expect(r).toMatchObject({ ok: false, block: 'paid', needsReview: true })
      expect(qb.calls.update).toBe(0)
      expect((await members())[0].state).toBe('pending')
      Object.keys(inv).forEach((k) => delete inv[k]); Object.assign(inv, clone(snapshot))   // nothing written, restore for the next case
    }
  })

  it('a discount line added in QuickBooks → refused (the line fingerprint can’t see it, so the write itself fails closed)', async () => {
    const { a, b } = await linkedPair()
    const p = await previewSharedInvoiceUpdate(b)
    expect(p.blockers).toEqual([])
    const inv = await invoiceOf(a)
    // A discount is real money the fingerprint normalization drops, so preview wouldn't catch it — the update must.
    inv.Line.push({ DetailType: 'DiscountLineDetail', Amount: 5, DiscountLineDetail: { PercentBased: false } })
    const r = await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: p.syncToken })
    expect(r).toMatchObject({ ok: false, block: 'lines_changed' })
    expect(qb.calls.update).toBe(0)
    expect((await members())[0].state).toBe('pending')
    expect((await invoiceOf(a)).Line.at(-1).DetailType).toBe('DiscountLineDetail')   // the discount was never overwritten
  })

  it('recovers if the local write is lost after QuickBooks succeeds: a re-run re-applies the member, never a second invoice', async () => {
    const { a, b } = await linkedPair()
    const r = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: (await previewSharedInvoiceUpdate(a)).syncToken })
    expect(r).toMatchObject({ ok: true, appliedOrderIds: [b] })
    const combined = (await est(a)).totalCents + (await est(b)).totalCents
    expect(Math.round((await invoiceOf(a)).TotalAmt * 100)).toBe(combined)
    // Simulate a crash AFTER the QuickBooks write but BEFORE the local membership / anchor writes committed:
    // the member is still 'pending' and the anchor's fingerprint + content hash are stale (as if lost).
    await db.update(retailInvoiceMembers).set({ state: 'pending', appliedTotalCents: null, appliedAt: null, appliedBy: null })
    await db.update(jobEstimates).set({ qbLinesFingerprint: 'stale', qbContentHash: 'stale' }).where(eq(jobEstimates.serviceOrderId, a))
    // QuickBooks already holds exactly this target, so the re-run reconciles instead of duplicating or refusing.
    const again = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: (await previewSharedInvoiceUpdate(a)).syncToken })
    expect(again.ok).toBe(true)
    expect(qb.invoices.size).toBe(1)
    expect((await members())[0].state).toBe('applied')
    expect((await est(b)).qbInvoiceId).toBeNull()
    expect(Math.round((await invoiceOf(a)).TotalAmt * 100)).toBe(combined)
  })

  it('an unlink injected AFTER the QuickBooks write but BEFORE membership is finalized is refused — the member is applied, never stranded', async () => {
    // afterUpdate fires once the invoice is written in QuickBooks, while syncRetailQBInvoice still holds the lock
    // (qb_status = 'syncing') and has NOT yet moved the member pending → applied. The unlink fence must reject it.
    const { a, b } = await linkedPair()
    const p = await previewSharedInvoiceUpdate(a)
    let unlink: Awaited<ReturnType<typeof unlinkSharedInvoiceMember>> | null = null
    qb.afterUpdate = async () => { unlink = await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' }) }
    const r = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: p.syncToken })
    expect(r).toMatchObject({ ok: true, appliedOrderIds: [b] })
    expect(unlink).toMatchObject({ ok: false, block: 'busy' })          // lock held across the whole finalization
    expect((await members())[0].state).toBe('applied')                 // on the invoice, not stranded
    expect((await est(b)).qbInvoiceId).toBeNull()                      // never gets a second invoice of its own
    expect(qb.invoices.size).toBe(1)
    expect(Math.round((await invoiceOf(a)).TotalAmt * 100)).toBe((await est(a)).totalCents + (await est(b)).totalCents)
    expect((await est(a)).qbStatus).toBe('created')                    // lock released after finalization, not stuck on 'syncing'
  })

  it('a DB finalization failure AFTER the QuickBooks write (ambiguous landing) is recoverable: no unlink, no 2nd invoice, no stripped charges, and a reviewed retry reconciles', async () => {
    const { a, b } = await linkedPair()
    const p = await previewSharedInvoiceUpdate(a)
    // The QuickBooks update lands, then Pitt Stop's local finalization throws → the sync ends in 'error' with the
    // member still 'pending' but its charges ALREADY on the QuickBooks invoice. This is the exact recovery defect.
    qb.afterUpdate = async () => { throw new Error('TEST: local DB finalization failed after QuickBooks succeeded') }
    const r = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: p.syncToken })
    expect(r.ok).toBe(false)
    expect(qb.calls.update).toBe(1)                                    // the QuickBooks write really happened
    expect((await est(a)).qbStatus).toBe('error')
    expect((await members())[0].state).toBe('pending')
    const combined = (await est(a)).totalCents + (await est(b)).totalCents
    expect(Math.round((await invoiceOf(a)).TotalAmt * 100)).toBe(combined)   // the member's charges ARE on the invoice

    // 1) The pending member can NOT be unlinked — the anchor isn't in a settled created/sent state.
    expect(await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' })).toMatchObject({ ok: false })
    expect((await members())[0].state).toBe('pending')
    // 2) …so it also can't create its own invoice (it would be a duplicate of charges already billed).
    expect(await createRetailQBInvoice({ orderId: b, actor: 'M' })).toMatchObject({ ok: false, status: 'refused' })
    expect(qb.invoices.size).toBe(1)
    // 3) An ordinary anchor Sync is refused (rebuilding without the pending member would strip its charges).
    expect(await syncRetailQBInvoice({ orderId: a, actor: 'M' })).toMatchObject({ ok: false, block: 'shared_pending' })
    expect(qb.calls.update).toBe(1)
    expect(Math.round((await invoiceOf(a)).TotalAmt * 100)).toBe(combined)

    // 4) The reviewed "Update invoice" reconciles: member applied, ONE invoice, combined total intact.
    const recoveryPreview = await previewSharedInvoiceUpdate(a)
    expect(recoveryPreview.blockers).toEqual([]) // recovery must be reachable from the review screen
    const again = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: recoveryPreview.syncToken })
    expect(again.ok).toBe(true)
    expect((await members())[0].state).toBe('applied')
    expect((await est(b)).qbInvoiceId).toBeNull()
    expect(qb.invoices.size).toBe(1)
    expect(Math.round((await invoiceOf(a)).TotalAmt * 100)).toBe(combined)
  })

  it('after an ambiguous failed write (error/pending), a reviewed retry that is itself refused keeps the anchor in error and unlink stays refused', async () => {
    const { a, b } = await linkedPair()
    // Ambiguous landing: QuickBooks write lands, local finalization throws → error + member pending, charges on it.
    qb.afterUpdate = async () => { throw new Error('TEST: finalization failed after QuickBooks succeeded') }
    expect((await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: (await previewSharedInvoiceUpdate(a)).syncToken })).ok).toBe(false)
    expect((await est(a)).qbStatus).toBe('error')
    expect((await members())[0].state).toBe('pending')

    // A reviewed retry refused PRE-write by a stale review must NOT promote error → created (that would re-open unlink).
    const stale = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: 'stale-token' })
    expect(stale).toMatchObject({ ok: false, block: 'stale' })
    expect((await est(a)).qbStatus).toBe('error')
    expect(await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' })).toMatchObject({ ok: false })
    expect((await members())[0].state).toBe('pending')

    // A reviewed retry refused because the member is now unready likewise keeps error; unlink still refused.
    await setExplicitPrice((await est(b)).id, 0, 'M'); await recomputeEstimate((await est(b)).id)
    const unready = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: (await previewSharedInvoiceUpdate(a)).syncToken })
    expect(unready).toMatchObject({ ok: false, block: 'member_unready' })
    expect((await est(a)).qbStatus).toBe('error')
    expect(await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' })).toMatchObject({ ok: false })
  })

  it('an unlink injected the instant the post-QuickBooks persist resolves (before membership is finalized) is refused — the lock is not released early', async () => {
    const { a, b } = await linkedPair()
    const p = await previewSharedInvoiceUpdate(a)
    // Run the unlink right after the FIRST post-QB jobEstimates write (the one carrying qbContentHash) resolves, but
    // before syncRetailQBInvoice continues to finalize membership. In the fixed code the lock is still held
    // ('syncing') there, so the unlink must be refused; the old early-unlock order would have let it through.
    let unlink: Awaited<ReturnType<typeof unlinkSharedInvoiceMember>> | null = null
    const real = holder.db!
    holder.db = dbWithUpdateHook(real, (v) => v != null && Object.prototype.hasOwnProperty.call(v, 'qbContentHash'),
      { after: async () => { unlink = await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' }) } }) as typeof db
    let r: Awaited<ReturnType<typeof updateSharedInvoice>>
    try { r = await updateSharedInvoice({ orderId: a, actor: 'M', expectedSyncToken: p.syncToken }) } finally { holder.db = real }
    expect(r).toMatchObject({ ok: true, appliedOrderIds: [b] })
    expect(unlink).toMatchObject({ ok: false })                      // lock still held ('syncing') → refused
    expect((await members())[0].state).toBe('applied')               // never stranded
    expect((await est(b)).qbInvoiceId).toBeNull()                    // never a 2nd invoice
    expect(qb.invoices.size).toBe(1)
    expect(Math.round((await invoiceOf(a)).TotalAmt * 100)).toBe((await est(a)).totalCents + (await est(b)).totalCents)
  })
})

describe('after the update', () => {
  it('editing the linked vehicle flags the shared invoice (owned by the other Job) as sync needed; Send waits', async () => {
    const { a, b } = await linkedPair()
    await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: (await previewSharedInvoiceUpdate(b)).syncToken })
    await setExplicitPrice((await est(b)).id, 16000, 'M'); await recomputeEstimate((await est(b)).id)
    expect(await flagQbSyncNeededIfInvoiced(b, 'a price changed')).toBe(true)
    expect((await est(a)).qbSyncError).toMatch(/sync needed — on a linked vehicle/)
    expect(await resolveRetailSend(a)).toMatchObject({ ok: false, block: 'sync_needed' })
    // Syncing from the anchor rebuilds BOTH vehicles at their current totals.
    const r = await syncRetailQBInvoice({ orderId: a, actor: 'M' })
    expect(r.ok).toBe(true)
    expect(Math.round((await invoiceOf(a)).TotalAmt * 100)).toBe((await est(a)).totalCents + (await est(b)).totalCents)
    expect((await members())[0].appliedTotalCents).toBe((await est(b)).totalCents)
  })

  it('Record Payment sees ONE invoice at the combined total (payments are never per-job duplicates)', async () => {
    const { a, b } = await linkedPair()
    await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: (await previewSharedInvoiceUpdate(b)).syncToken })
    // The member has no invoice of its own → nothing to pay there.
    expect(await previewRetailPayment({ orderId: b, actor: 'M' })).toMatchObject({ ok: false, block: 'no_invoice' })
    expect((await est(b)).qbPaymentStatus).toBe('none')
    expect((await est(a)).qbInvoiceId).toBeTruthy()
  })

  it('an applied member can’t be unlinked or removed from the Work Board here', async () => {
    const { b } = await linkedPair()
    await updateSharedInvoice({ orderId: b, actor: 'M', expectedSyncToken: (await previewSharedInvoiceUpdate(b)).syncToken })
    expect(await unlinkSharedInvoiceMember({ orderId: b, actor: 'M' })).toMatchObject({ ok: false, block: 'applied' })
    await db.update(serviceOrders).set({ status: 'arrived' }).where(eq(serviceOrders.id, b))
    expect((await planOrderRemoval(b)).preview).toMatchObject({ kind: 'shared_invoice', blocked: true })
  })
})

describe('regression — single-job invoicing is unchanged', () => {
  it('Create → Sync no-op → Send resolution on an ordinary Job behaves exactly as before', async () => {
    const a = await kelvinWithInvoice()
    const inv = await invoiceOf(a)
    expect(inv.Line.some((l: { DetailType: string }) => l.DetailType === 'DescriptionOnly')).toBe(false)
    expect(inv.PrivateNote).toBe(`PSID:${(await est(a)).id}`)
    expect(Math.round(inv.TotalAmt * 100)).toBe((await est(a)).totalCents)
    expect(await syncRetailQBInvoice({ orderId: a, actor: 'M' })).toMatchObject({ ok: true, noop: true })
    expect(qb.calls.update).toBe(0)
    expect(await resolveRetailSend(a)).toMatchObject({ ok: true, recipient: KELVIN.email })
    expect(await loadSharedInvoiceState(a)).toBeNull()
    // A second Create is idempotent (local guard).
    expect(await createRetailQBInvoice({ orderId: a, actor: 'M' })).toMatchObject({ ok: true, alreadyExisted: true })
    expect(qb.invoices.size).toBe(1)
  })
})
