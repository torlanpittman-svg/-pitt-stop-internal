/**
 * Guided Job-screen parts flow — the money and record behaviour, end to end on the real schema:
 *   • "Add part to this service" attaches the part to the service that installs it (labor included);
 *   • customer price × quantity reaches the job total and the Invoice Draft EXACTLY once; our cost never does;
 *   • whoever adds the part enters the customer price (required, explicit — never a silent $0); our cost
 *     is stored only when a manager entered it; an already-unpriced part still blocks invoice creation;
 *   • removing a part keeps its service; removing a service removes its attached parts AND their charges,
 *     leaves unrelated services / standalone parts alone, is audited, and only FLAGS a linked QB invoice;
 *   • retries / double-taps never remove or charge anything twice.
 * In-memory PGlite from the real Drizzle schema + production-shaped catalog. No real DB/QB/network.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { and, eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, setServicePrice, getEstimateView, getFullEstimate } from '@/apps/workflow/estimate-db'
import { getOrderWithContext } from '@/apps/workflow/db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { addEstimatePart, addPartForJob, attachedPartsOf, partIsCharged, removeServiceWithParts, removeEstimatePartWithLabor, updateEstimatePart } from './estimate-parts'
import { groupJobItems } from './job-items-view'
import { serviceOrders, vehicles, jobParts, jobLineItems, jobEstimates, serviceOrderEvents } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
})

/** A retail Job with priced services on its estimate. */
async function job(services: Array<[string, number]>) {
  const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Accord', year: '2019' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `GP-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'in_progress', customerName: 'Test Customer', services: services.map(([t]) => t) }).returning()
  const est = await getOrCreateEstimate(o.id, 'Manager')
  const ids: Record<string, string> = {}
  for (const [title, cents] of services) {
    const s = await addService(est.id, title, { actor: 'Manager' })
    await setServicePrice(est.id, s.id, cents, 'Manager')
    ids[title] = s.id
  }
  return { orderId: o.id, estimateId: est.id, ids }
}
const M = 'Manager'
const livePart = async (id: string) => (await db.select().from(jobParts).where(eq(jobParts.id, id)))[0]
const events = async (orderId: string, type: string) => db.select().from(serviceOrderEvents).where(and(eq(serviceOrderEvents.serviceOrderId, orderId), eq(serviceOrderEvents.eventType, type)))
async function draft(orderId: string) {
  const order = (await getOrderWithContext(orderId))!
  return buildInvoiceDraft({ order, full: await getFullEstimate(orderId), paymentLabel: 'Card charge', role: 'manager' })
}

describe('Add part to this service', () => {
  it('attaches the part to the service (labor included) and bills customer price × quantity once; our cost is not charged', async () => {
    const { orderId, ids } = await job([['Oil change', 6000]])
    const part = await addPartForJob(orderId, { description: 'Oil filter', quantity: 2, unitCostCents: 400, sellPriceCents: 1250, partNumber: 'OF-1' }, M, 'manager', ids['Oil change'])

    expect(part.laborStatus).toBe('included')
    expect(part.laborServiceId).toBe(ids['Oil change'])
    expect(part.jobLineItemId).toBeTruthy()
    expect((await attachedPartsOf(orderId, ids['Oil change'])).map((p) => p.id)).toEqual([part.id])
    expect(await partIsCharged(part)).toBe(true)

    const view = await getEstimateView(orderId)
    const g = groupJobItems(view)
    expect(g.services[0].parts.map((p) => [p.description, p.lineCents, p.quantity])).toEqual([['Oil filter', 2500, 2]])
    expect(g.standalone).toEqual([])
    expect(view.workTotalCents).toBe(6000 + 2500)   // price × qty, once — 400¢ cost nowhere in it
    expect(view.incomplete).toBe(false)

    const d = await draft(orderId)
    expect(d.workPriceCents).toBe(8500)
    expect(d.pricingIncomplete).toBe(false)
    expect(d.serviceBreakdown).toEqual(expect.arrayContaining([{ title: 'Oil change', cents: 6000 }, { title: 'Oil filter', cents: 2500 }]))
  })
  it('a stale / foreign service id is refused BEFORE anything is written', async () => {
    const { orderId } = await job([['Oil change', 6000]])
    await expect(addPartForJob(orderId, { description: 'Oil filter', sellPriceCents: 1000 }, M, 'manager', '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/no longer on this job/)
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId))).toHaveLength(0)
    expect((await getEstimateView(orderId)).workTotalCents).toBe(6000)
  })
  it('an employee adds a part to a service WITH the customer price: price × quantity charged once, no manager pricing needed, cost never stored', async () => {
    const { orderId, ids } = await job([['Oil change', 6000]])
    // unitCostCents is sent anyway (a tampered client) — it must not be stored for a non-manager.
    const part = await addPartForJob(orderId, { description: 'Cabin air filter', quantity: 3, unitCostCents: 999, sellPriceCents: '1250' }, 'Employee', null, ids['Oil change'])
    expect(part.laborStatus).toBe('included'); expect(part.laborServiceId).toBe(ids['Oil change'])
    expect(part.sellPriceCents).toBe(1250); expect(part.unitCostCents).toBeNull(); expect(part.supply).toBe('shop')
    expect(await partIsCharged(part)).toBe(true)
    const view = await getEstimateView(orderId)
    expect(view.incomplete).toBe(false)
    expect(view.workTotalCents).toBe(6000 + 3 * 1250)
    const g = groupJobItems(view)
    expect(g.services[0].parts.map((p) => [p.description, p.lineCents, p.unitCostCents])).toEqual([['Cabin air filter', 3750, null]])
    const d = await draft(orderId)
    expect(d.pricingIncomplete).toBe(false)
    expect(d.workPriceCents).toBe(9750)
    expect(d.serviceBreakdown.map((l) => l.cents).reduce((a, b) => a + b, 0)).toBe(9750)   // exactly once
    const [line] = await db.select().from(jobLineItems).where(eq(jobLineItems.id, part.jobLineItemId!))
    expect(line.priceCents).toBe(1250); expect(Number(line.qty)).toBe(3); expect(line.costCents).toBe(0)
  })
  it('an employee adds a standalone part ("Add to this job") with the customer price — charged once under Parts', async () => {
    const { orderId } = await job([['Oil change', 6000]])
    const part = await addPartForJob(orderId, { description: 'Wiper blades', quantity: 2, sellPriceCents: 1200 }, 'Employee', null, null)
    expect(part.laborServiceId).toBeNull(); expect(part.unitCostCents).toBeNull()
    const g = groupJobItems(await getEstimateView(orderId))
    expect(g.services[0].parts).toEqual([])
    expect(g.standalone.map((p) => [p.description, p.lineCents])).toEqual([['Wiper blades', 2400]])
    expect((await draft(orderId)).workPriceCents).toBe(8400)
    expect((await draft(orderId)).pricingIncomplete).toBe(false)
  })
  it('a manager’s cost is stored but never changes the customer charge', async () => {
    const { orderId, ids } = await job([['Oil change', 6000]])
    const part = await addPartForJob(orderId, { description: 'Oil filter', quantity: 1, unitCostCents: 400, sellPriceCents: 900 }, M, 'manager', ids['Oil change'])
    expect(part.unitCostCents).toBe(400); expect(part.sellPriceCents).toBe(900)
    expect((await draft(orderId)).workPriceCents).toBe(6900)
    expect(groupJobItems(await getEstimateView(orderId)).services[0].parts[0].lineCents).toBe(900)
  })
  it('a missing, blank, negative or invalid customer price is refused BEFORE anything is written (never a silent $0)', async () => {
    const { orderId, ids } = await job([['Oil change', 6000]])
    const bad: Array<[unknown, RegExp]> = [
      [undefined, /Enter the customer price/], [null, /Enter the customer price/], ['', /Enter the customer price/], ['   ', /Enter the customer price/],
      [-1, /negative/], ['-5', /negative/], ['abc', /Check the customer price/], [Number.NaN, /Check the customer price/], [Infinity, /Check the customer price/],
    ]
    for (const [price, re] of bad) {
      await expect(addPartForJob(orderId, { description: 'Gasket', sellPriceCents: price as never }, 'Employee', null, ids['Oil change'])).rejects.toThrow(re)
      await expect(addPartForJob(orderId, { description: 'Gasket', sellPriceCents: price as never }, M, 'manager', null)).rejects.toThrow(re)
    }
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId))).toEqual([])
    expect(await events(orderId, 'part_added')).toEqual([])
    const view = await getEstimateView(orderId)
    expect(view.workTotalCents).toBe(6000); expect(view.incomplete).toBe(false)
    expect(groupJobItems(view).services[0].parts).toEqual([])
  })
  it('$0 must be typed explicitly — then it is a priced, no-charge line (invoice not blocked)', async () => {
    const { orderId, ids } = await job([['Oil change', 6000]])
    const part = await addPartForJob(orderId, { description: 'Warranty clip', sellPriceCents: 0 }, 'Employee', null, ids['Oil change'])
    expect(part.sellPriceCents).toBe(0); expect(part.jobLineItemId).not.toBeNull()
    const view = await getEstimateView(orderId)
    expect(view.workTotalCents).toBe(6000); expect(view.incomplete).toBe(false)
    expect((await draft(orderId)).pricingIncomplete).toBe(false)
  })
  it('an existing unpriced part (older data / other entry paths) still blocks invoice creation until a manager prices it', async () => {
    const { orderId } = await job([['Oil change', 6000]])
    const part = await addEstimatePart(orderId, { description: 'Cabin air filter', sellPriceCents: null }, M)   // not the guided add
    expect(part.jobLineItemId).toBeNull()
    expect(await partIsCharged(part)).toBe(false)
    let view = await getEstimateView(orderId)
    expect(view.workTotalCents).toBe(6000)
    expect(view.incomplete).toBe(true)
    expect((await draft(orderId)).pricingIncomplete).toBe(true)   // QB invoice creation refuses on this

    await updateEstimatePart(orderId, part.id, { sellPriceCents: 1800 }, M)
    view = await getEstimateView(orderId)
    expect(view.workTotalCents).toBe(7800)
    expect(view.incomplete).toBe(false)
    expect((await draft(orderId)).pricingIncomplete).toBe(false)
    expect(await partIsCharged((await livePart(part.id))!)).toBe(true)
  })
  it('"Add to this job" (no service) is a standalone part, listed under Parts, charged once', async () => {
    const { orderId } = await job([['Oil change', 6000]])
    const part = await addPartForJob(orderId, { description: 'Wiper blades', quantity: 1, sellPriceCents: 2400 }, M, 'manager', null)
    expect(part.laborStatus).toBe('needs_review')
    expect(part.laborServiceId).toBeNull()
    const g = groupJobItems(await getEstimateView(orderId))
    expect(g.services[0].parts).toEqual([])
    expect(g.standalone.map((p) => [p.description, p.lineCents])).toEqual([['Wiper blades', 2400]])
    expect((await getEstimateView(orderId)).workTotalCents).toBe(8400)
  })
})

describe('Remove part', () => {
  it('removes only that part and its charge; the parent service stays; a retry is a no-op', async () => {
    const { orderId, ids } = await job([['Oil change', 6000]])
    const part = await addPartForJob(orderId, { description: 'Oil filter', sellPriceCents: 1250, quantity: 2 }, M, 'manager', ids['Oil change'])
    const lineId = part.jobLineItemId!

    await removeEstimatePartWithLabor(orderId, part.id, { action: 'keep' }, M)
    expect((await livePart(part.id))!.status).toBe('cancelled')
    expect(await db.select().from(jobLineItems).where(eq(jobLineItems.id, lineId))).toHaveLength(0)   // the charge is gone with it
    const view = await getEstimateView(orderId)
    expect(view.services.map((s) => s.title)).toEqual(['Oil change'])
    expect(view.parts ?? []).toEqual([])
    expect(view.workTotalCents).toBe(6000)
    const before = (await events(orderId, 'service_removed')).length + (await events(orderId, 'part_removed')).length

    await removeEstimatePartWithLabor(orderId, part.id, { action: 'keep' }, M)   // double-tap
    expect((await getEstimateView(orderId)).workTotalCents).toBe(6000)
    expect((await events(orderId, 'service_removed')).length + (await events(orderId, 'part_removed')).length).toBe(before)
  })
})

describe('Remove service (with its attached parts)', () => {
  async function fixture() {
    const f = await job([['Brake job', 20000], ['Oil change', 6000]])
    const pads = await addPartForJob(f.orderId, { description: 'Brake pads', sellPriceCents: 4500, unitCostCents: 2000 }, M, 'manager', f.ids['Brake job'])
    const rotors = await addPartForJob(f.orderId, { description: 'Rotors', sellPriceCents: 9000, quantity: 2 }, M, 'manager', f.ids['Brake job'])
    const filter = await addPartForJob(f.orderId, { description: 'Oil filter', sellPriceCents: 1250 }, M, 'manager', f.ids['Oil change'])
    const wipers = await addPartForJob(f.orderId, { description: 'Wiper blades', sellPriceCents: 2400 }, M, 'manager', null)
    expect((await getEstimateView(f.orderId)).workTotalCents).toBe(20000 + 4500 + 18000 + 6000 + 1250 + 2400)
    return { ...f, pads, rotors, filter, wipers }
  }
  it('removes the service, its attached parts and their charges together; unrelated services and standalone parts are untouched; audited once', async () => {
    const f = await fixture()
    const r = await removeServiceWithParts(f.orderId, f.ids['Brake job'], M)
    expect(r.title).toBe('Brake job')
    expect(r.removedParts.sort()).toEqual(['Brake pads', 'Rotors'])
    expect(r.pricingImpactCents).toBe(20000 + 4500 + 18000)
    expect(r.qbSyncNeeded).toBe(false)

    const view = await getEstimateView(f.orderId)
    expect(view.services.map((s) => s.title)).toEqual(['Oil change'])
    const g = groupJobItems(view)
    expect(g.services[0].parts.map((p) => p.description)).toEqual(['Oil filter'])
    expect(g.standalone.map((p) => p.description)).toEqual(['Wiper blades'])
    expect(view.workTotalCents).toBe(6000 + 1250 + 2400)
    expect((await draft(f.orderId)).workPriceCents).toBe(9650)

    for (const p of [f.pads, f.rotors]) expect((await livePart(p.id))!.status).toBe('cancelled')
    for (const p of [f.filter, f.wipers]) expect((await livePart(p.id))!.status).not.toBe('cancelled')
    // The Job's own text list follows (employees' Services list stays in step).
    const [o] = await db.select({ services: serviceOrders.services }).from(serviceOrders).where(eq(serviceOrders.id, f.orderId))
    expect(o.services).not.toContain('Brake job')
    expect(o.services).toContain('Oil change')

    const audit = await events(f.orderId, 'service_removed_with_parts')
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0].note!)).toMatchObject({ title: 'Brake job', removedParts: expect.arrayContaining(['Brake pads', 'Rotors']), pricingImpactCents: 42500 })
  })
  it('a service with no attached parts removes just itself', async () => {
    const f = await fixture()
    const r = await removeServiceWithParts(f.orderId, f.ids['Oil change'], M)
    // Oil filter IS attached to Oil change — so it goes; Wiper blades (standalone) stays.
    expect(r.removedParts).toEqual(['Oil filter'])
    const f2 = await job([['Interior detail', 15000]])
    const r2 = await removeServiceWithParts(f2.orderId, f2.ids['Interior detail'], M)
    expect(r2.removedParts).toEqual([])
    expect(r2.pricingImpactCents).toBe(15000)
    expect((await getEstimateView(f2.orderId)).services).toEqual([])
  })
  it('a second remove of the same service fails loudly and changes nothing (no double removal)', async () => {
    const f = await fixture()
    await removeServiceWithParts(f.orderId, f.ids['Brake job'], M)
    const total = (await getEstimateView(f.orderId)).workTotalCents
    await expect(removeServiceWithParts(f.orderId, f.ids['Brake job'], M)).rejects.toThrow()
    expect((await getEstimateView(f.orderId)).workTotalCents).toBe(total)
    expect(await events(f.orderId, 'service_removed_with_parts')).toHaveLength(1)
  })
  it('on an already-invoiced Job the linked QuickBooks invoice is only FLAGGED for sync — never voided or rewritten', async () => {
    const f = await fixture()
    await db.update(jobEstimates).set({ qbInvoiceId: 'QB-1001', qbInvoiceNumber: '1001', qbStatus: 'created' }).where(eq(jobEstimates.id, f.estimateId))
    const r = await removeServiceWithParts(f.orderId, f.ids['Brake job'], M)
    expect(r.qbSyncNeeded).toBe(true)
    const [est] = await db.select().from(jobEstimates).where(eq(jobEstimates.id, f.estimateId))
    expect(est.qbInvoiceId).toBe('QB-1001')
    expect(est.qbStatus).toBe('created')
    expect(est.qbSyncError).toMatch(/QuickBooks sync needed/)
    expect((await draft(f.orderId)).qb.syncNeeded).toBe(true)
  })
})
