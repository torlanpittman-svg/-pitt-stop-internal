/**
 * Estimate API — the part-review actions are manager/admin only (enforced on the server), and the
 * manager path converts / clarifies through the real route. PGlite + real schema; no QB/network.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
const auth = vi.hoisted(() => ({ role: 'manager' as string | null }))
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => (auth.role ? { name: 'Someone', role: auth.role } : null),
  employeeAuthorizedFromRequest: async () => !!auth.role,
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, addLine } from '@/apps/workflow/estimate-db'
import { serviceOrders, vehicles, jobParts, jobServices } from '@/drizzle/schema'
import { POST } from './route'

let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  process.env.ESTIMATE_LAYER_ENABLED = 'true'
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
  auth.role = 'manager'
})

async function jobWithPartLine() {
  const [v] = await db.insert(vehicles).values({ make: 'Ford' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: 'RT-1', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
  const est = await getOrCreateEstimate(o.id, 'M')
  const svc = await addService(est.id, 'Driver mirror assembly', { actor: 'M' })
  await addLine(svc.id, { type: 'labor', name: 'Driver mirror assembly', description: null, qty: 1, unit: 'each', costCents: 0, priceCents: 26500, taxable: false, taxCategory: 'detailing' })
  return { orderId: o.id, serviceId: svc.id }
}
const call = (orderId: string, body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: orderId }) })

describe('estimate part-review actions — server-side permissions', () => {
  it('employees and signed-out users cannot convert or clarify (403), and nothing changes', async () => {
    const { orderId, serviceId } = await jobWithPartLine()
    for (const role of ['employee', null]) {
      auth.role = role
      expect((await call(orderId, { action: 'convert_to_part', serviceId })).status).toBe(403)
      expect((await call(orderId, { action: 'clarify_part', serviceId, part: { description: 'Mirror' } })).status).toBe(403)
    }
    expect(await db.select().from(jobParts)).toHaveLength(0)
    expect((await db.select().from(jobServices).where(eq(jobServices.id, serviceId)))[0].kind).toBe('service')
  })

  it('a manager converts through the route; the returned view confirms it (what the Saved status checks)', async () => {
    const { orderId, serviceId } = await jobWithPartLine()
    const res = await call(orderId, { action: 'convert_to_part', serviceId, part: { fitment: '2019 Ford F-150' } })
    const body = await res.json() as { ok: boolean; view: { services: unknown[]; parts: Array<{ serviceId: string; lineCents: number; invoiceText: string; laborStatus: string }> } }
    expect(body.ok).toBe(true)
    expect(body.view.services).toEqual([])
    expect(body.view.parts[0]).toMatchObject({ serviceId, lineCents: 26500, laborStatus: 'needs_review', invoiceText: 'Driver mirror assembly — Fits: 2019 Ford F-150' })
  })

  it('a refused conversion returns a plain error and changes nothing (input kept for retry)', async () => {
    const { orderId } = await jobWithPartLine()
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    const est = await getOrCreateEstimate(o.id, 'M')
    const paint = await addService(est.id, 'Paint mirror covers', { actor: 'M' })
    const res = await call(orderId, { action: 'convert_to_part', serviceId: paint.id })
    expect(res.status).toBe(500)
    expect((await res.json() as { error: string }).error).toMatch(/describes work, not a part/)
    expect(await db.select().from(jobParts)).toHaveLength(0)
  })
})

describe('price edits — a missing or unloaded amount is refused, never saved as $0', () => {
  const priceOf = async (serviceId: string) => {
    const [svc] = await db.select().from(jobServices).where(eq(jobServices.id, serviceId))
    const lines = await db.execute(`SELECT price_cents FROM job_line_items WHERE job_service_id = '${svc.id}' AND generated = false`)
    return (lines.rows as { price_cents: number }[]).map((l) => l.price_cents)
  }

  it('set_service_price with no / null / blank / text / NaN / negative amount → 400 and the saved price stays', async () => {
    const { orderId, serviceId } = await jobWithPartLine()
    for (const cents of [undefined, null, '', '125', 'abc', Number.NaN, -5, {}]) {
      const res = await call(orderId, { action: 'set_service_price', serviceId, cents })
      expect(res.status).toBe(400)
      expect((await res.json() as { ok: boolean }).ok).toBe(false)
    }
    expect((await call(orderId, { action: 'set_service_price', cents: 100 })).status).toBe(400)   // no line named
    expect(await priceOf(serviceId)).toEqual([26500])
  })

  it('set_work_total and a priced add_service refuse a missing amount the same way', async () => {
    const { orderId, serviceId } = await jobWithPartLine()
    expect((await call(orderId, { action: 'set_work_total' })).status).toBe(400)
    expect((await call(orderId, { action: 'set_work_total', cents: null })).status).toBe(400)
    expect((await call(orderId, { action: 'add_service', title: 'Wax', custom: true, cents: 'abc' })).status).toBe(400)
    expect(await priceOf(serviceId)).toEqual([26500])
    expect(await db.select().from(jobServices).where(eq(jobServices.title, 'Wax'))).toHaveLength(0)
  })

  it('a real edit still saves — including an intentional $0 — and leaves other lines alone', async () => {
    const { orderId, serviceId } = await jobWithPartLine()
    const added = await (await call(orderId, { action: 'add_service', title: 'Hand wax', custom: true, cents: 4500 })).json() as { ok: boolean; view: { services: Array<{ id: string; title: string; priceCents: number | null }> } }
    expect(added.ok).toBe(true)
    const wax = added.view.services.find((s) => s.title === 'Hand wax')!
    expect(wax.priceCents).toBe(4500)
    const res = await (await call(orderId, { action: 'set_service_price', serviceId: wax.id, cents: 0 })).json() as typeof added
    expect(res.view.services.map((s) => [s.title, s.priceCents])).toEqual([['Driver mirror assembly', 26500], ['Hand wax', 0]])
    expect(await priceOf(serviceId)).toEqual([26500])
  })
})

// The Job screen's inline price boxes send this same action, one save at a time (see inline-price.ts).
describe('Job screen inline prices — consecutive rows through the editor’s own price edit', () => {
  type View = { services: Array<{ id: string; title: string; priceCents: number | null }>; workTotalCents: number; flat: boolean; incomplete: boolean }
  const prices = (v: View) => Object.fromEntries(v.services.map((s) => [s.title, s.priceCents]))
  const save = async (orderId: string, serviceId: string, cents: number) => {
    const res = await call(orderId, { action: 'set_service_price', serviceId, cents })
    return (await res.json()) as { ok: boolean; view: View }
  }
  /** Checked in through Quick Entry: Exterior Wash entered at $50; Interior Detail and Wax with no price. */
  async function quickEntryJob() {
    const { createQuickEntryJob } = await import('@/apps/quick-entry/jobs-db')
    const lines = [
      { kind: 'package' as const, name: 'Exterior Wash', catalogId: null, priceCents: 5000 },
      { kind: 'package' as const, name: 'Interior Detail', catalogId: null, priceCents: 0 },
      { kind: 'addon' as const, name: 'Wax', catalogId: null, priceCents: 0 },
    ]
    const { serviceOrderId } = await createQuickEntryJob({
      customerName: 'Pat Driver', vehicle: { year: '2019', make: 'Ford', model: 'F-150' }, createdBy: 'Torlan', lines,
      agreedPriceCents: 5000, agreedServices: [{ originalText: 'Exterior Wash', confirmedCents: 5000 }],
    })
    const { getEstimateView } = await import('@/apps/workflow/estimate-db')
    return { orderId: serviceOrderId, view: (await getEstimateView(serviceOrderId)) as View }
  }
  async function totals(orderId: string) {
    const { getOrderRetailWorkValueCents } = await import('@/apps/workflow/production')
    const { buildInvoiceDraft } = await import('@/apps/workflow/invoice-draft')
    const { getFullEstimate } = await import('@/apps/workflow/estimate-db')
    const { getOrderWithContext } = await import('@/apps/workflow/db')
    const draft = buildInvoiceDraft({ order: (await getOrderWithContext(orderId))!, full: await getFullEstimate(orderId), paymentLabel: 'Card charge', role: 'manager' })
    return { totalPrice: await getOrderRetailWorkValueCents(orderId), draftLines: draft.serviceBreakdown, draftWork: draft.workPriceCents }
  }

  it('$125.50 then $25 on the next row: both save, the Quick Entry $50 stays, Total price and the Invoice Draft agree', async () => {
    const { orderId, view } = await quickEntryJob()
    expect(prices(view)).toEqual({ 'Exterior Wash': 5000, 'Interior Detail': null, Wax: null })
    expect((await totals(orderId)).totalPrice).toBe(5000)
    const id = (title: string) => view.services.find((s) => s.title === title)!.id

    const first = await save(orderId, id('Interior Detail'), 12550)
    expect(first.ok).toBe(true)
    expect(prices(first.view)).toEqual({ 'Exterior Wash': 5000, 'Interior Detail': 12550, Wax: null })
    const second = await save(orderId, id('Wax'), 2500)
    expect(prices(second.view)).toEqual({ 'Exterior Wash': 5000, 'Interior Detail': 12550, Wax: 2500 })
    expect(second.view).toMatchObject({ workTotalCents: 20050, flat: false, incomplete: false })

    expect(await totals(orderId)).toEqual({
      totalPrice: 20050, draftWork: 20050,
      draftLines: [{ title: 'Exterior Wash', cents: 5000 }, { title: 'Interior Detail', cents: 12550 }, { title: 'Wax', cents: 2500 }],
    })

    // Changing the price that came from Quick Entry is an ordinary price edit: only that line moves.
    const third = await save(orderId, id('Exterior Wash'), 6000)
    expect(prices(third.view)).toEqual({ 'Exterior Wash': 6000, 'Interior Detail': 12550, Wax: 2500 })
    expect(await totals(orderId)).toMatchObject({ totalPrice: 21050, draftWork: 21050 })
    // One price line per service — an edit updates the line, it never adds a second one.
    const n = await db.execute(`SELECT count(*)::int AS n FROM job_line_items WHERE generated = false`)
    expect((n.rows[0] as { n: number }).n).toBe(3)
  })

  it('an employee cannot save a price (403) and nothing changes', async () => {
    const { orderId, view } = await quickEntryJob()
    auth.role = 'employee'
    const res = await call(orderId, { action: 'set_service_price', serviceId: view.services[1].id, cents: 12550 })
    expect(res.status).toBe(403)
    expect((await totals(orderId)).totalPrice).toBe(5000)
  })

  it('a removed (cancelled) Job refuses the price (409)', async () => {
    const { orderId, view } = await quickEntryJob()
    await db.update(serviceOrders).set({ status: 'cancelled' }).where(eq(serviceOrders.id, orderId))
    const res = await call(orderId, { action: 'set_service_price', serviceId: view.services[1].id, cents: 12550 })
    expect(res.status).toBe(409)
    expect((await totals(orderId)).totalPrice).toBe(5000)
  })
})
