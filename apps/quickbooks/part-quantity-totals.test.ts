/**
 * A part's quantity counts everywhere, and every surface agrees.
 *
 * The same synthetic Job is traced through: the Job header ("Total price" — getOrderRetailWorkValueCents), the
 * item list (getEstimateView), the canonical Invoice Draft, the stored estimate totals, the Production log, and
 * the ACTUAL QuickBooks create and sync requests (QuickBooks mocked at the HTTP layer only; real estimate /
 * draft / payload code on in-memory PGlite, shop supplies + card charge switched on).
 *
 * Regression: the header and the Production log summed unit prices and dropped the quantity — 2 × $125.50
 * showed as $125.50 — while the list, Invoice Draft and QuickBooks were already right.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({
    shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000,
    paymentEnabled: true, paymentBps: 300, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825,
  }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
type QbLine = { Amount: number; Description: string; SalesItemLineDetail: { Qty: number; UnitPrice: number; ItemRef: { value: string }; TaxCodeRef: { value: string } } }
const qb = vi.hoisted(() => ({ posts: [] as Array<Record<string, unknown>>, live: [] as unknown[], invoice: null as Record<string, unknown> | null }))
vi.mock('@/apps/quickbooks/client', () => ({
  qboEscape: (s: string) => s.replace(/'/g, "\\'"),
  queryQBO: async (q: string) => {
    if (/from Invoice where Id = 'INV-1'/i.test(q)) return { Invoice: qb.invoice ? [qb.invoice] : [] }
    if (/from Item MAXRESULTS/i.test(q)) return { Item: qb.live }
    if (/from Item where Name = 'Labor'/i.test(q)) return { Item: [{ Id: '53', Name: 'Labor' }] }
    if (/from Item where Name = 'Fees'/i.test(q)) return { Item: [{ Id: '1010000012', Name: 'Fees' }] }
    if (/from Account/i.test(q)) return { Account: [{ Id: '1', Name: 'Services' }] }
    if (/from Invoice/i.test(q)) return { Invoice: [] }
    throw new Error(`unexpected QBO query: ${q}`)
  },
  qbApiRequest: async (req: { method?: string; path: string; body?: Record<string, unknown> }) => {
    const method = req.method ?? 'GET'
    if (method === 'GET' && req.path === '/invoice/INV-1' && qb.invoice) return { Invoice: qb.invoice }
    if (method === 'POST' && req.path === '/invoice') {
      qb.posts.push(req.body!)
      const lines = req.body!.Line as Array<{ Amount: number }>
      qb.invoice = { ...req.body, Id: 'INV-1', DocNumber: '100900', SyncToken: String(Number(qb.invoice?.SyncToken ?? -1) + 1), TotalAmt: Math.round(lines.reduce((s, l) => s + l.Amount, 0) * 100) / 100, Line: lines.map(() => ({ DetailType: 'SalesItemLineDetail' })) }
      return { Invoice: qb.invoice }
    }
    throw new Error(`unexpected QB call: ${method} ${req.path}`)
  },
}))
vi.mock('@/apps/quickbooks/retail-customer', async (orig) => ({
  ...(await orig<object>()),
  resolveRetailCustomer: async () => ({ qbCustomerId: 'CUST-1', billEmail: 'test@example.invalid', matchedBy: 'test', created: false, emailConflict: false, emailStatus: 'ok' }),
  resolveRetailCustomerIdentity: async () => ({ qbCustomerId: 'CUST-1' }),
}))

import { seedProductionCatalog, LIVE_QB_ITEMS, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, promoteTextServices, setServicePrice, getEstimateView, getFullEstimate, getEstimateRow } from '@/apps/workflow/estimate-db'
import { getOrderWithContext } from '@/apps/workflow/db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { getOrderRetailWorkValueCents, dailyProduction, weeklyProduction, itemizedSubtotalFromLines } from '@/apps/workflow/production'
import { addPartForJobOnce, updateEstimatePart, removeEstimatePart, decidePartLabor } from '@/apps/parts/estimate-parts'
import { groupJobItems } from '@/apps/parts/job-items-view'
import { createRetailQBInvoice, syncRetailQBInvoice } from './retail-invoice-service'
import { serviceOrders, vehicles, jobServices, dealerScans } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema }); holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]); await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await db.execute('DELETE FROM dealer_scans')
  qb.posts = []; qb.live = LIVE_QB_ITEMS; qb.invoice = null
  await seedProductionCatalog(db)
})

const M = 'Manager'
const TZ = 'America/Chicago'
const COMPLETED = new Date('2026-11-17T18:00:00.000Z')   // Tue Nov 17, noon in the shop timezone
/** A completed, itemized retail Job: Interior Detail $100.00. */
async function job() {
  const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Civic', year: '2019' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `QTY-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', customerName: 'Synthetic Customer', services: ['Interior Detail'], completedAt: COMPLETED, completedBy: 'Tony' }).returning()
  const est = await getOrCreateEstimate(o.id, M)
  await promoteTextServices(est.id, o.id)
  const [svc] = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, est.id))
  await setServicePrice(est.id, svc.id, 10000, M)
  return { orderId: o.id, estimateId: est.id, serviceId: svc.id }
}
const draftOf = async (orderId: string) => buildInvoiceDraft({ order: (await getOrderWithContext(orderId))!, full: await getFullEstimate(orderId), paymentLabel: 'Card charge', role: 'admin' })
const productionOf = async (orderId: string) => (await dailyProduction('2026-11-17', TZ)).jobs.find((j) => j.id === orderId)!
const cents = (dollars: number) => Math.round(dollars * 100)
const lastPost = () => qb.posts[qb.posts.length - 1].Line as QbLine[]

/** Every surface shows the same work value; fees and total follow the existing rules. Returns the draft. */
async function expectAllAgree(orderId: string, workCents: number) {
  const header = await getOrderRetailWorkValueCents(orderId)
  const view = await getEstimateView(orderId)
  const d = await draftOf(orderId)
  const est = (await getEstimateRow(orderId))!
  expect(header).toBe(workCents)                       // Job header "Total price"
  expect(view.workTotalCents).toBe(workCents)          // item list
  expect(d.workPriceCents).toBe(workCents)             // Invoice Draft
  expect((await productionOf(orderId)).priceCents).toBe(workCents)   // Production log
  // Existing fee rules, unchanged: 3% shop supplies (cap $20) and 3% card charge, each on the work value; no tax.
  const shop = Math.min(Math.round(workCents * 0.03), 2000)
  const card = Math.round(workCents * 0.03)
  expect(d.shopSupplies.cents).toBe(shop)
  expect(d.paymentCharge.cents).toBe(card)
  expect(d.tax.cents).toBe(0)
  expect(d.totalCents).toBe(workCents + shop + card)
  expect(est.totalCents).toBe(d.totalCents)
  return d
}
/** The request QuickBooks actually received: one line per charge, Amount = Qty × UnitPrice, Σ = the draft total. */
function expectQbRequest(d: Awaited<ReturnType<typeof draftOf>>, expected: Array<[description: RegExp, amountCents: number]>) {
  const lines = lastPost()
  expect(lines.map((l) => cents(l.Amount))).toEqual(expected.map(([, c]) => c))
  lines.forEach((l, i) => {
    expect(l.Description).toMatch(expected[i][0])
    expect(l.SalesItemLineDetail.Qty).toBe(1)
    expect(cents(l.SalesItemLineDetail.UnitPrice * l.SalesItemLineDetail.Qty)).toBe(cents(l.Amount))
    expect(l.SalesItemLineDetail.TaxCodeRef.value).toBe('NON')
  })
  expect(lines.reduce((s, l) => s + cents(l.Amount), 0)).toBe(d.totalCents)
  expect(cents(Number(qb.invoice!.TotalAmt))).toBe(d.totalCents)
}

describe('itemizedSubtotalFromLines — the pricing engine’s sum, never a quantity-blind one', () => {
  it('2 × $125.50 is $251.00', () => {
    expect(itemizedSubtotalFromLines([{ p: 12550, q: '2.00' }])).toBe(25100)
  })
  it('sums each line as unit price × quantity, rounding per line exactly as the estimate does', () => {
    expect(itemizedSubtotalFromLines([{ p: 10000, q: '1.00' }, { p: 12550, q: '2.00' }, { p: 333, q: '1.50' }])).toBe(10000 + 25100 + 500)
    expect(itemizedSubtotalFromLines(JSON.stringify([{ p: 1999, q: '3' }]))).toBe(5997)   // a driver may hand json back as text
  })
  it('no lines / unreadable input is 0 (the caller then falls through to the agreed price, never a guess)', () => {
    for (const v of [[], null, undefined, 'not json', '{}']) expect(itemizedSubtotalFromLines(v)).toBe(0)
  })
})

describe('2 × $125.50 on a service — header, list, Invoice Draft, Production and QuickBooks all say $251.00', () => {
  it('add → create invoice → edit quantity → sync → remove → sync', async () => {
    const { orderId, serviceId } = await job()
    await expectAllAgree(orderId, 10000)

    // ── add: 2 × $125.50 under the service ──
    const { part } = await addPartForJobOnce(orderId, { description: 'Brake pads', quantity: 2, sellPriceCents: 12550, partNumber: 'BP-1', requestId: 'c3f1a9d2-0000-4000-8000-00000000a001' }, M, 'manager', serviceId)
    let d = await expectAllAgree(orderId, 10000 + 25100)
    const listed = groupJobItems(await getEstimateView(orderId)).services[0].parts[0]
    expect([listed.quantity, listed.sellPriceCents, listed.lineCents]).toEqual([2, 12550, 25100])
    expect(d.serviceBreakdown).toEqual(expect.arrayContaining([{ title: 'Interior Detail', cents: 10000 }, { title: 'Brake pads', cents: 25100 }]))

    expect(await createRetailQBInvoice({ orderId, actor: M })).toMatchObject({ ok: true, status: 'created', totalCents: d.totalCents })
    expectQbRequest(d, [[/./, 10000], [/Brake pads.*BP-1/, 25100], [/Shop supplies/, 1053], [/Card charge/, 1053]])

    // ── edit the quantity: 2 → 3 ──
    await updateEstimatePart(orderId, part.id, { quantity: 3 }, M)
    d = await expectAllAgree(orderId, 10000 + 37650)
    expect(d.qb.syncNeeded).toBe(true)
    expect(await syncRetailQBInvoice({ orderId, actor: M })).toMatchObject({ ok: true })
    expectQbRequest(d, [[/./, 10000], [/Brake pads/, 37650], [/Shop supplies/, 1430], [/Card charge/, 1430]])

    // ── edit the unit price: $125.50 → $99.99 (3 × $99.99 = $299.97) ──
    await updateEstimatePart(orderId, part.id, { sellPriceCents: 9999 }, M)
    d = await expectAllAgree(orderId, 10000 + 29997)

    // ── remove the part: its whole charge goes, once ──
    await removeEstimatePart(orderId, part.id, M)
    d = await expectAllAgree(orderId, 10000)
    expect(await syncRetailQBInvoice({ orderId, actor: M })).toMatchObject({ ok: true })
    expectQbRequest(d, [[/./, 10000], [/Shop supplies/, 300], [/Card charge/, 300]])

    // Correcting the Job never moved its completion (the production day is unchanged).
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    expect(o.completedAt!.toISOString()).toBe(COMPLETED.toISOString())
    expect((await productionOf(orderId)).effectiveDate).toBe('2026-11-17')
  })
})

describe('whole-job parts, mixed with a service part', () => {
  it('each part counts unit price × quantity once, wherever it sits; fractional quantities round per line like the estimate', async () => {
    const { orderId, serviceId } = await job()
    await addPartForJobOnce(orderId, { description: 'Brake pads', quantity: 2, sellPriceCents: 12550 }, M, 'manager', serviceId)   // $251.00 under the service
    await addPartForJobOnce(orderId, { description: 'Wiper blades', quantity: 4, sellPriceCents: 1999 }, M, 'manager')              // $79.96 on the whole job
    await addPartForJobOnce(orderId, { description: 'Trim tape', quantity: 1.5, sellPriceCents: 333 }, M, 'manager')                // 1.5 × $3.33 = $4.995 → $5.00
    const work = 10000 + 25100 + 7996 + 500
    const d = await expectAllAgree(orderId, work)
    const g = groupJobItems(await getEstimateView(orderId))
    expect(g.services[0].parts.map((p) => p.lineCents)).toEqual([25100])
    expect(g.standalone.map((p) => [p.description, p.lineCents]).sort()).toEqual([['Trim tape', 500], ['Wiper blades', 7996]])
    expect(d.shopSupplies.cents).toBe(1308)   // 3% of $435.96
    // Existing rule, unchanged: a whole-job part's installation labor must be reviewed before invoicing.
    const blocked = await createRetailQBInvoice({ orderId, actor: M })
    expect(blocked).toMatchObject({ ok: false, status: 'refused' })
    expect(qb.posts).toEqual([])
    for (const p of g.standalone) await decidePartLabor(orderId, p.id, { action: 'part_only' }, M, 'manager')
    expect(await createRetailQBInvoice({ orderId, actor: M })).toMatchObject({ ok: true, totalCents: d.totalCents })
    expect(lastPost().map((l) => cents(l.Amount)).sort((a, b) => a - b)).toEqual([500, 1308, 1308, 7996, 10000, 25100])
    expect(cents(Number(qb.invoice!.TotalAmt))).toBe(d.totalCents)
  })

  it('a large job hits the existing $20 shop-supplies cap — the quantity fix does not bend the fee rules', async () => {
    const { orderId } = await job()
    await addPartForJobOnce(orderId, { description: 'Tires', quantity: 4, sellPriceCents: 21000 }, M, 'manager')
    const d = await expectAllAgree(orderId, 10000 + 84000)
    expect(d.shopSupplies.cents).toBe(2000)
  })
})

describe('Production log and separation', () => {
  it('the week total and its retail share use the same quantity-aware value', async () => {
    const { orderId } = await job()
    await addPartForJobOnce(orderId, { description: 'Brake pads', quantity: 2, sellPriceCents: 12550 }, M, 'manager')
    const week = await weeklyProduction('2026-11-17', TZ)
    expect(week.jobs.find((j) => j.id === orderId)!.priceCents).toBe(35100)
    expect(week.weekTotalCents).toBe(35100)
    expect(week.byKind).toEqual({ retail: 35100, dealer: 0, unknown: 0 })
    expect(week.days.find((x) => x.date === '2026-11-17')!.totalCents).toBe(35100)
  })

  it('a manager’s flat Work Price still wins over the lines (precedence unchanged)', async () => {
    const { orderId, estimateId } = await job()
    await addPartForJobOnce(orderId, { description: 'Brake pads', quantity: 2, sellPriceCents: 12550 }, M, 'manager')
    await db.update(schema.jobEstimates).set({ explicitTotalCents: 40000 }).where(eq(schema.jobEstimates.id, estimateId))
    expect(await getOrderRetailWorkValueCents(orderId)).toBe(40000)
    expect((await productionOf(orderId)).priceCents).toBe(40000)
  })

  it('a dealer Job’s production value is still its flat dealer rate — never estimate lines', async () => {
    const [v] = await db.insert(vehicles).values({ make: 'Kia', model: 'Soul', year: '2020', vin: 'KNDJ23AU0L7000001' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: `QTY-D-${++seq}`, vehicleId: v.id, source: 'dealer_checkin', status: 'ready', customerName: 'Synthetic Dealer', services: ['Full Detail'], completedAt: COMPLETED }).returning()
    await db.insert(dealerScans).values({ vin: 'KNDJ23AU0L7000001', vinSource: 'manual', dealershipName: 'Synthetic Dealer', serviceOrderId: o.id, rate: 200 } as typeof dealerScans.$inferInsert)
    const p = await productionOf(o.id)
    expect(p).toMatchObject({ source: 'dealer', priceCents: 20000 })
  })
})
