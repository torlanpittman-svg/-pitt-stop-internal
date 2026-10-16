/**
 * Estimate service removal must be durable. A service promoted from the Job's employee-facing
 * text list (service_orders.services) used to come back on every reopen, because removal deleted
 * only the job_services row and prepareEstimateView → promoteTextServices re-seeded it from the
 * untouched text list. Driven against an in-memory PGlite pushed from the real Drizzle schema.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

import {
  prepareEstimateView, getEstimateView, getFullEstimate, setServicePrice, getOrCreateEstimate,
  removeEstimateService, addService,
} from '@/apps/workflow/estimate-db'
import { serviceOrders, vehicles, serviceOrderEvents, jobServices, jobEstimates } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})

beforeEach(async () => {
  for (const t of ['job_line_items', 'job_services', 'job_estimates', 'service_order_events', 'service_orders', 'vehicles']) {
    await db.execute(`DELETE FROM ${t}`)
  }
})

/** Isolated fixture shaped like the Mizell estimate: intake text services incl. a double-spaced label. */
async function estimateOrder(services: string[], status = 'estimate') {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2020' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: `RM-TEST-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status,
    customerName: 'Test Customer', services,
  }).returning()
  return o.id
}
const titles = async (orderId: string) => (await getEstimateView(orderId)).services.map((s) => s.title)
const idOf = async (orderId: string, title: string) => (await getEstimateView(orderId)).services.find((s) => s.title === title)!.id

describe('removeEstimateService — removal survives leaving, reopening, and refreshing', () => {
  it('a promoted service stays removed after repeated reopen (prepareEstimateView) and refresh (getEstimateView)', async () => {
    const orderId = await estimateOrder(['Two mirrors  and painted', 'Interior detail', 'Oil change'])
    await prepareEstimateView(orderId, 'Manager')   // first open promotes the text services
    expect(await titles(orderId)).toEqual(['Two mirrors  and painted', 'Interior detail', 'Oil change'])

    await removeEstimateService(orderId, await idOf(orderId, 'Two mirrors  and painted'), 'Manager')
    expect(await titles(orderId)).toEqual(['Interior detail', 'Oil change'])

    // Leave + reopen several times (each page open runs the full prepare path), then a plain refresh.
    for (let i = 0; i < 3; i++) {
      const view = await prepareEstimateView(orderId, 'Manager')
      expect(view.services.map((s) => s.title)).toEqual(['Interior detail', 'Oil change'])
    }
    expect(await titles(orderId)).toEqual(['Interior detail', 'Oil change'])
  })

  it('is not recreated from the stored Job services list: the text list is updated too', async () => {
    const orderId = await estimateOrder(['Two mirrors  and painted', 'Interior detail'])
    await prepareEstimateView(orderId, 'Manager')
    await removeEstimateService(orderId, await idOf(orderId, 'Two mirrors  and painted'), 'Manager')

    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    expect(o.services).toEqual(['Interior detail'])
    const rows = await db.select().from(jobServices)
    expect(rows.map((r) => r.title).filter((t) => t !== 'Fees & Charges')).toEqual(['Interior detail'])
  })

  it('removes a manually-added service too, and audits every removal (append-only event)', async () => {
    const orderId = await estimateOrder(['Interior detail'])
    const est = await getOrCreateEstimate(orderId, 'Manager')
    await prepareEstimateView(orderId, 'Manager')
    const manual = await addService(est.id, 'Paint Mirror Covers')
    await setServicePrice(est.id, manual.id, 15000, 'Manager')

    const r = await removeEstimateService(orderId, manual.id, 'Manager')
    expect(r).toMatchObject({ title: 'Paint Mirror Covers', pricingImpactCents: 15000 })
    await prepareEstimateView(orderId, 'Manager')
    expect(await titles(orderId)).toEqual(['Interior detail'])

    const events = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))
    const removed = events.filter((e) => e.eventType === 'service_removed')
    expect(removed).toHaveLength(1)
    expect(JSON.parse(removed[0].note!)).toMatchObject({ serviceId: manual.id, removed: 'Paint Mirror Covers', pricingImpactCents: 15000 })
  })

  it('preserves the other services, their prices, and the itemized total', async () => {
    const orderId = await estimateOrder(['Two mirrors  and painted', 'Interior detail', 'Oil change'])
    const est = await getOrCreateEstimate(orderId, 'Manager')
    await prepareEstimateView(orderId, 'Manager')
    await setServicePrice(est.id, await idOf(orderId, 'Two mirrors  and painted'), 20000, 'Manager')
    await setServicePrice(est.id, await idOf(orderId, 'Interior detail'), 17500, 'Manager')
    await setServicePrice(est.id, await idOf(orderId, 'Oil change'), 6000, 'Manager')
    const before = await getFullEstimate(orderId)
    const keptLines = before!.services.filter((s) => s.title !== 'Two mirrors  and painted').flatMap((s) => s.lines.filter((l) => !l.generated))

    await removeEstimateService(orderId, await idOf(orderId, 'Two mirrors  and painted'), 'Manager')
    const view = await prepareEstimateView(orderId, 'Manager')
    expect(view.services.map((s) => [s.title, s.priceCents])).toEqual([['Interior detail', 17500], ['Oil change', 6000]])
    expect(view.workTotalCents).toBe(23500)

    const after = await getFullEstimate(orderId)
    const afterLines = after!.services.flatMap((s) => s.lines.filter((l) => !l.generated))
    for (const l of keptLines) {
      expect(afterLines.find((x) => x.id === l.id)).toMatchObject({ qty: l.qty, priceCents: l.priceCents, taxable: l.taxable, taxCategory: l.taxCategory })
    }
  })

  it('keeps the Job text entry when another remaining service still carries that name', async () => {
    const orderId = await estimateOrder(['Wax'])
    const est = await getOrCreateEstimate(orderId, 'Manager')
    await prepareEstimateView(orderId, 'Manager')
    const dup = await addService(est.id, 'wax')   // manual duplicate, different row
    await removeEstimateService(orderId, dup.id, 'Manager')
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    expect(o.services).toEqual(['Wax'])
    await prepareEstimateView(orderId, 'Manager')
    expect(await titles(orderId)).toEqual(['Wax'])
  })

  it('works on a Work Board job estimate too (non-standalone), and flags QB sync if an invoice is linked', async () => {
    const orderId = await estimateOrder(['Interior detail', 'Oil change'], 'in_progress')
    await prepareEstimateView(orderId, 'Manager')
    const est = await getOrCreateEstimate(orderId, 'Manager')
    await db.update(jobEstimates).set({ qbInvoiceId: 'QB-TEST-1' }).where(eq(jobEstimates.id, est.id))
    const r = await removeEstimateService(orderId, await idOf(orderId, 'Oil change'), 'Manager')
    expect(r.qbSyncNeeded).toBe(true)
    await prepareEstimateView(orderId, 'Manager')
    expect(await titles(orderId)).toEqual(['Interior detail'])
    const [e] = await db.select().from(jobEstimates).where(eq(jobEstimates.id, est.id))
    expect(e.qbInvoiceId).toBe('QB-TEST-1')   // never voided/cleared — only flagged
    expect(e.qbSyncError).toMatch(/sync needed/i)
  })

  it('refuses a service from another estimate, a system row, or an already-removed id — nothing changes', async () => {
    const a = await estimateOrder(['Interior detail'])
    const b = await estimateOrder(['Oil change'])
    await prepareEstimateView(a, 'Manager'); await prepareEstimateView(b, 'Manager')
    const foreign = await idOf(b, 'Oil change')
    await expect(removeEstimateService(a, foreign, 'Manager')).rejects.toThrow(/no longer on this estimate/i)
    expect(await titles(b)).toEqual(['Oil change'])

    const own = await idOf(a, 'Interior detail')
    await removeEstimateService(a, own, 'Manager')
    await expect(removeEstimateService(a, own, 'Manager')).rejects.toThrow(/no longer on this estimate/i)
    const events = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, a))
    expect(events.filter((e) => e.eventType === 'service_removed')).toHaveLength(1)   // a double-tap never double-audits
  })
})
