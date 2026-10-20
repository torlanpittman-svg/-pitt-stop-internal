/**
 * Flat Work Price → QuickBooks invoice. The agreed flat amount (explicit_pretax) is authoritative: Create
 * and Sync must invoice exactly that amount through the one pricing engine, or refuse BEFORE any
 * QuickBooks call (and before changing the estimate) when the service prices would need reconciling.
 * Never silently replaced by a different per-service line sum.
 *
 * Real estimate/draft/payload code against PGlite; QuickBooks mocked at the HTTP layer only.
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
const qb = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; body?: Record<string, unknown> }>, live: [] as unknown[], invoice: null as Record<string, unknown> | null }))
vi.mock('@/apps/quickbooks/client', () => ({
  qboEscape: (s: string) => s.replace(/'/g, "\\'"),
  queryQBO: async (q: string) => {
    qb.calls.push({ method: 'QUERY', path: q })
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
    qb.calls.push({ method, path: req.path, body: req.body })
    if (method === 'GET' && req.path === '/invoice/INV-1' && qb.invoice) return { Invoice: qb.invoice }
    if (method === 'POST' && req.path === '/invoice') {
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
import { getOrCreateEstimate, promoteTextServices, setServicePrice, setExplicitPrice, recomputeEstimate, prepareEstimateView, getFullEstimate } from '@/apps/workflow/estimate-db'
import { createRetailQBInvoice, syncRetailQBInvoice } from './retail-invoice-service'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { getOrderWithContext } from '@/apps/workflow/db'
import { serviceOrders, vehicles, jobEstimates, jobServices, jobLineItems } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema }); holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]); await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  qb.calls = []; qb.live = LIVE_QB_ITEMS; qb.invoice = null
  await seedProductionCatalog(db)
})

/** The Quick Entry shape: services promoted from the Job's text, then the manager's flat Work Price. */
async function flatJob(services: string[], workCents: number, linePrices: Array<number | null> = []) {
  const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Civic', year: '2019' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `FP-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', customerName: 'Flat Test', services }).returning()
  const est = await getOrCreateEstimate(o.id, 'Manager')
  await promoteTextServices(est.id, o.id)
  const rows = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, est.id))
  const byTitle = new Map(rows.map((r) => [r.title, r]))
  // Per-service prices that already exist on the Job (e.g. entered before the flat price was set).
  for (let i = 0; i < services.length; i++) if (linePrices[i] != null) await setServicePrice(est.id, byTitle.get(services[i])!.id, linePrices[i]!, 'Manager')
  await setExplicitPrice(est.id, workCents, 'Manager')
  await recomputeEstimate(est.id)
  await prepareEstimateView(o.id, 'Manager')   // as the app does when the Estimate opens (never itemizes a flat Job)
  return { orderId: o.id, estimateId: est.id }
}
async function draftOf(orderId: string) {
  return buildInvoiceDraft({ order: (await getOrderWithContext(orderId))!, full: await getFullEstimate(orderId), paymentLabel: 'Card charge', role: 'admin' })
}
const estRow = async (id: string) => (await db.select().from(jobEstimates).where(eq(jobEstimates.id, id)))[0]
const lineCount = async (estimateId: string) => {
  const svc = await db.select({ id: jobServices.id }).from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
  let n = 0
  for (const s of svc) n += (await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, s.id))).filter((l) => !l.generated).length
  return n
}
const invoiceTotalCents = () => Math.round(Number(qb.invoice?.TotalAmt ?? 0) * 100)

describe('Create — flat Work Price is preserved', () => {
  it('Quick Entry flat $120 with no per-service prices → invoices exactly $120 of work (agreed amount kept)', async () => {
    const { orderId, estimateId } = await flatJob(['Interior Detail', 'Exterior Wash'], 12000)
    const before = await draftOf(orderId)
    expect(before.workPriceCents).toBe(12000)
    const r = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(r).toMatchObject({ ok: true, status: 'created', totalCents: before.totalCents })
    expect(invoiceTotalCents()).toBe(before.totalCents)
    const after = await draftOf(orderId)
    expect(after.workPriceCents).toBe(12000)
    expect(after.referenceCents).toBeNull()
    expect(after.pricingIncomplete).toBe(false)
    expect((await estRow(estimateId)).explicitTotalCents).toBe(12000)
  })

  it('flat $120 but service prices add up to $300 → refused before any QuickBooks write; estimate unchanged', async () => {
    const { orderId, estimateId } = await flatJob(['Interior Detail', 'Exterior Wash'], 12000, [18000, 12000])
    const before = await estRow(estimateId)
    const r = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(r).toMatchObject({ ok: false, status: 'refused' })
    expect(r.error).toMatch(/\$120\.00/)
    expect(r.error).toMatch(/\$300\.00/)
    expect(qb.calls).toEqual([])
    const after = await estRow(estimateId)
    expect(after.priceMode).toBe(before.priceMode)
    expect(after.explicitTotalCents).toBe(12000)
    expect(after.qbStatus).toBe('none')
    expect((await draftOf(orderId)).workPriceCents).toBe(12000)
  })

  it('flat $120 with service prices that add up to exactly $120 → invoices $120, nothing left to reconcile', async () => {
    const { orderId } = await flatJob(['Interior Detail', 'Exterior Wash'], 12000, [7000, 5000])
    const before = await draftOf(orderId)
    const r = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(r).toMatchObject({ ok: true, status: 'created', totalCents: before.totalCents })
    expect(invoiceTotalCents()).toBe(before.totalCents)
    const lines = (qb.invoice!.Line as unknown[])
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const after = await draftOf(orderId)
    expect(after.workPriceCents).toBe(12000)
    expect(after.referenceCents).toBeNull()   // nothing to reconcile → Record Payment isn't blocked later
    expect(after.pricingIncomplete).toBe(false)
  })

  it('flat $120 with only SOME services priced → refused before any QuickBooks write; estimate unchanged', async () => {
    const { orderId, estimateId } = await flatJob(['Interior Detail', 'Exterior Wash'], 12000, [7000, null])
    const r = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(r).toMatchObject({ ok: false, status: 'refused' })
    expect(r.error).toMatch(/\$120\.00/)
    expect(qb.calls).toEqual([])
    const after = await estRow(estimateId)
    expect(after.priceMode).toBe('explicit_pretax')
    expect(after.explicitTotalCents).toBe(12000)
    expect(await lineCount(estimateId)).toBe(1)
  })
})

describe('Sync — the same flat-price rule', () => {
  it('flat Job whose service prices no longer match the agreed amount → refused before any QuickBooks call', async () => {
    const { orderId, estimateId } = await flatJob(['Interior Detail', 'Exterior Wash'], 12000)
    expect((await createRetailQBInvoice({ orderId, actor: 'Manager' })).ok).toBe(true)
    const total0 = invoiceTotalCents()
    // Back to a flat price after per-service prices appeared that add up to something else.
    const rows = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
    await setServicePrice(estimateId, rows.find((s) => s.title === 'Interior Detail')!.id, 18000, 'Manager')
    await setServicePrice(estimateId, rows.find((s) => s.title === 'Exterior Wash')!.id, 12000, 'Manager')
    await setExplicitPrice(estimateId, 12000, 'Manager'); await recomputeEstimate(estimateId)
    qb.calls = []
    const r = await syncRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(r).toMatchObject({ ok: false, block: 'pricing' })
    expect(qb.calls).toEqual([])
    expect(invoiceTotalCents()).toBe(total0)
    expect((await estRow(estimateId)).priceMode).toBe('explicit_pretax')
  })

  it('flat Job with no per-service prices syncs at the agreed amount', async () => {
    const { orderId } = await flatJob(['Interior Detail'], 12000)
    expect((await createRetailQBInvoice({ orderId, actor: 'Manager' })).ok).toBe(true)
    const d = await draftOf(orderId)
    const r = await syncRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(r).toMatchObject({ ok: true })
    expect(invoiceTotalCents()).toBe(d.totalCents)
    expect((await draftOf(orderId)).workPriceCents).toBe(12000)
  })
})
