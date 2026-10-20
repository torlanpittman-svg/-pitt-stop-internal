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
  removeEstimateService, removeServiceFromJob, renameService, syncEstimateServicesToJob, setApproval,
} from '@/apps/workflow/estimate-db'
import { getOrderWithContext, listActiveOrders } from '@/apps/workflow/db'
import { validateCompletion } from '@/apps/workflow/completion'
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

  describe('approval changes (real setApproval flow — no hand-fixed data)', () => {
    /** What every consumer reads: the Job page / Work Board split and the Finish Job gate input. */
    const views = async (orderId: string) => {
      const job = (await getOrderWithContext(orderId))!
      const board = (await listActiveOrders()).find((o) => o.id === orderId)!
      return { job: job.items!.services, board: board.items!.services, finishable: validateCompletion(job.items!.services, false, { allWorkComplete: true }).ok }
    }

    it('add → decline: the declined work leaves the Job, the Work Board and the Finish Job input immediately', async () => {
      const orderId = await order([])
      const est = await itemizeMiller(orderId)
      const extra = await addService(est.id, 'Headlight Restoration', { actor: 'Manager' })
      await setServicePrice(est.id, extra.id, 8000, 'Manager')
      expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner', 'Headlight Restoration'])

      await setApproval(est.id, orderId, extra.id, 'declined', 'Manager')   // no estimate reopen
      const MILLER = ['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner']
      expect(await jobServicesText(orderId)).toEqual(MILLER)
      expect(await views(orderId)).toEqual({ job: MILLER, board: MILLER, finishable: true })
      // Price, catalog identity and the estimate row itself are kept (declined, not deleted).
      const row = (await userRows()).find((r) => r.id === extra.id)!
      expect(row).toMatchObject({ approvalState: 'declined', catalogId: extra.catalogId })
      expect((await getEstimateView(orderId)).services.find((x) => x.id === extra.id)?.priceCents).toBe(8000)
      // Reopening the estimate does not bring it back.
      await prepareEstimateView(orderId, 'Manager')
      expect(await jobServicesText(orderId)).toEqual(MILLER)
    })

    it('decline → reapprove: the work comes back exactly once', async () => {
      const orderId = await order([])
      const est = await itemizeMiller(orderId)
      const wax = (await getEstimateView(orderId)).services.find((x) => x.title === 'Wax')!
      await setApproval(est.id, orderId, wax.id, 'declined', 'Manager')
      expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Wash', 'Leather Conditioner'])
      await setApproval(est.id, orderId, wax.id, 'approved', 'Manager')
      await setApproval(est.id, orderId, wax.id, 'approved', 'Manager')   // double tap
      await prepareEstimateView(orderId, 'Manager')
      const back = ['Interior Detail', 'Exterior Wash', 'Leather Conditioner', 'Wax']
      expect(await jobServicesText(orderId)).toEqual(back)
      expect((await views(orderId)).job).toEqual(back)
      expect((await userRows()).filter((r) => r.title === 'Wax')).toHaveLength(1)   // no duplicate estimate row/charge
      expect((await getEstimateView(orderId)).workTotalCents).toBe(42500)
    })

    it('declining an intake service (promoted from the Job list) also takes it off the Job; unrelated Job text is untouched', async () => {
      const orderId = await order(['Interior Detail', 'Pick up keys from front desk'])
      const est = await getOrCreateEstimate(orderId, 'Manager')
      await prepareEstimateView(orderId, 'Manager')
      const interior = (await getEstimateView(orderId)).services.find((x) => x.title === 'Interior Detail')!
      // 'Pick up keys…' was promoted too; detach it to model operational text with no estimate row.
      const keys = (await getEstimateView(orderId)).services.find((x) => x.title.startsWith('Pick up'))!
      await db.delete(jobServices).where(eq(jobServices.id, keys.id))
      await setApproval(est.id, orderId, interior.id, 'declined', 'Manager')
      expect(await jobServicesText(orderId)).toEqual(['Pick up keys from front desk'])
    })

    it('a declined duplicate never hides the same work that is still approved on another line', async () => {
      const orderId = await order([])
      const est = await itemizeMiller(orderId)
      const dup = await addService(est.id, 'wax', { actor: 'Manager' })
      await setApproval(est.id, orderId, dup.id, 'declined', 'Manager')
      expect(await jobServicesText(orderId)).toEqual(['Interior Detail', 'Exterior Wash', 'Wax', 'Leather Conditioner'])
    })

    it('when every service is declined the Job has no work, so Finish Job refuses (no_services)', async () => {
      const orderId = await order([])
      const est = await itemizeMiller(orderId)
      for (const x of (await getEstimateView(orderId)).services) await setApproval(est.id, orderId, x.id, 'declined', 'Manager')
      expect(await jobServicesText(orderId)).toEqual([])
      const job = (await getOrderWithContext(orderId))!
      expect(validateCompletion(job.items!.services, false, { allWorkComplete: true })).toEqual({ ok: false, error: 'no_services' })
    })

    it('dealer Jobs are untouched by approval changes', async () => {
      const orderId = await order(['Complete Detail'], { source: 'dealer_checkin', serviceType: 'dealer' })
      const est = await getOrCreateEstimate(orderId, 'Manager')
      const [row] = await db.insert(jobServices).values({ jobEstimateId: est.id, title: 'Complete Detail', source: 'manual' }).returning()
      await setApproval(est.id, orderId, row.id, 'declined', 'Manager')
      expect(await jobServicesText(orderId)).toEqual(['Complete Detail'])
    })
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
