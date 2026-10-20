/**
 * Enter services once. A service added on the Estimate must also appear in the Job's Services list
 * (service_orders.services), or the Job shows "No services yet" next to a priced estimate total and
 * staff re-enter the same work. Reference case (2026-10-20, Miller): an appointment Job whose
 * estimate was itemized as Interior Detail $200 + Exterior Wash $50 + Wax $100 + Leather Conditioner
 * $75 = $425 while service_orders.services stayed []. Driven against an in-memory PGlite pushed from
 * the real Drizzle schema.
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
  prepareEstimateView, getEstimateView, setServicePrice, getOrCreateEstimate, addService,
  removeEstimateService, removeServiceFromJob, renameService, syncEstimateServicesToJob,
} from '@/apps/workflow/estimate-db'
import { serviceOrders, vehicles, jobServices } from '@/drizzle/schema'

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

async function order(services: string[], over: Partial<typeof serviceOrders.$inferInsert> = {}) {
  const [v] = await db.insert(vehicles).values({ make: 'Mercedes-Benz', model: 'CLS-Class', year: '2023' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: `SYNC-TEST-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived',
    customerName: 'Test Customer', services, ...over,
  }).returning()
  return o.id
}
const jobServicesText = async (orderId: string) => (await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId)))[0].services
const userRows = async () => (await db.select().from(jobServices)).filter((r) => r.source !== 'system')

/** Itemize the Miller estimate exactly as entered on the Estimate screen. */
async function itemizeMiller(orderId: string) {
  const est = await getOrCreateEstimate(orderId, 'Manager')
  await prepareEstimateView(orderId, 'Manager')
  for (const [title, cents] of [['Interior Detail', 20000], ['Exterior Wash', 5000], ['Wax', 10000], ['Leather Conditioner', 7500]] as const) {
    const svc = await addService(est.id, title, { actor: 'Manager' })
    await setServicePrice(est.id, svc.id, cents, 'Manager')
  }
  return est
}

describe('estimate services ↔ Job Services stay one list', () => {
  it('services added on the estimate appear on the Job, in order, with the itemized total unchanged', async () => {
    const orderId = await order([])
    await itemizeMiller(orderId)
    expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner'])
    const view = await getEstimateView(orderId)
    expect(view.services.map((s) => [s.title, s.priceCents])).toEqual([
      ['Interior Detail', 20000], ['Exterior Wash', 5000], ['Wax', 10000], ['Leather Conditioner', 7500],
    ])
    expect(view.workTotalCents).toBe(42500)
  })

  it('reopening never duplicates a service or its charge', async () => {
    const orderId = await order([])
    await itemizeMiller(orderId)
    for (let i = 0; i < 3; i++) await prepareEstimateView(orderId, 'Manager')
    expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner'])
    expect((await userRows()).map((r) => r.title)).toEqual(['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner'])
    expect((await getEstimateView(orderId)).workTotalCents).toBe(42500)
  })

  it('heals an existing Job whose estimate already has services but whose Services list is empty (opening the estimate)', async () => {
    const orderId = await order([])
    await itemizeMiller(orderId)
    await db.update(serviceOrders).set({ services: [] }).where(eq(serviceOrders.id, orderId))   // the pre-fix state
    await prepareEstimateView(orderId, 'Manager')
    expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner'])
    expect((await getEstimateView(orderId)).workTotalCents).toBe(42500)
  })

  it('a service already on the Job (any spacing/case) is not added twice', async () => {
    const orderId = await order(['interior detail '])
    await itemizeMiller(orderId)
    expect(await jobServicesText(orderId)).toEqual(['interior detail ', 'Exterior Wash', 'Wax', 'Leather Conditioner'])
  })

  it('removal and rename on the estimate stay reflected on the Job', async () => {
    const orderId = await order([])
    await itemizeMiller(orderId)
    const wax = (await getEstimateView(orderId)).services.find((s) => s.title === 'Wax')!
    await removeEstimateService(orderId, wax.id, 'Manager')
    const wash = (await getEstimateView(orderId)).services.find((s) => s.title === 'Exterior Wash')!
    await renameService(orderId, wash.id, 'Exterior Hand Wash', 'Manager')
    await prepareEstimateView(orderId, 'Manager')
    expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Hand Wash', 'Leather Conditioner'])
    expect((await getEstimateView(orderId)).workTotalCents).toBe(32500)
  })

  it('removing from the Job removes the estimate line and its price; it is not re-added on reopen', async () => {
    const orderId = await order([])
    await itemizeMiller(orderId)
    await removeServiceFromJob(orderId, 'Leather Conditioner', 'Manager')
    await prepareEstimateView(orderId, 'Manager')
    expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Wash', 'Wax'])
    expect((await getEstimateView(orderId)).workTotalCents).toBe(35000)
  })

  it('a declined service is not put on the Job as work', async () => {
    const orderId = await order([])
    const est = await itemizeMiller(orderId)
    const extra = await addService(est.id, 'Headlight Restoration', { actor: 'Manager' })
    await db.update(jobServices).set({ approvalState: 'declined' }).where(eq(jobServices.id, extra.id))
    await db.update(serviceOrders).set({ services: ['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner'] }).where(eq(serviceOrders.id, orderId))
    await syncEstimateServicesToJob(orderId)
    expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner'])
  })

  it('parts are not added to the Services list (they live in Parts)', async () => {
    const orderId = await order([])
    const est = await getOrCreateEstimate(orderId, 'Manager')
    await addService(est.id, 'Wiper blades', { kind: 'part', actor: 'Manager' })
    expect(await jobServicesText(orderId)).toEqual([])
  })

  it('dealer Jobs are never touched (dealer isolation)', async () => {
    const orderId = await order(['Complete Detail'], { source: 'dealer_checkin', serviceType: 'dealer' })
    const est = await getOrCreateEstimate(orderId, 'Manager')
    await db.insert(jobServices).values({ jobEstimateId: est.id, title: 'Something else', source: 'manual' })
    await syncEstimateServicesToJob(orderId)
    expect(await jobServicesText(orderId)).toEqual(['Complete Detail'])
  })
})
