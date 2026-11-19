/**
 * TEST FIXTURE — a retail engine-replacement job shaped like the real one that exposed the repetitive
 * installation-labor review: one priced "Installation Labor — Replacement engine" line, an unrelated
 * Mini Detail and a custom labor line, the engine itself (labor already added), and 14 small parts
 * that all still need a labor review. Built through the real data layer (no hand-written rows), so it
 * works against any getDb() target — the in-memory test DB or a local PGlite walkthrough.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { serviceOrders, vehicles, serviceCatalog, jobParts } from '@/drizzle/schema'
import { getOrCreateEstimate, addService, setServicePrice } from '@/apps/workflow/estimate-db'
import { addEstimatePart, decidePartLabor } from '@/apps/parts/estimate-parts'

/** [description, quantity, customer price each (cents)] */
export const ENGINE_JOB_PARTS: readonly (readonly [string, number, number])[] = [
  ['NGK spark plugs', 8, 1627], ['Fan clutch', 1, 14708], ['Transmission pan gasket', 1, 2149], ['Torque converter seal', 1, 2291],
  ['Gasket material', 1, 2419], ['Antifreeze, 1 gallon', 1, 4070], ['Insulator NIC 35725', 4, 1281], ['M12-1.75 torque lock nut', 1, 1388],
  ['Valve cover gasket set', 1, 14862], ['Manifold gasket set', 1, 7938], ['Timing cover gasket set', 1, 6514], ['Oil filter', 1, 1627],
  ['10W-30 motor oil, 5 qt', 1, 6921], ['Dorman heater hose assembly', 1, 10075],
]
export const ENGINE_JOB_LABOR_CENTS = 211000
/** Work total: engine 1,500.00 + 14 parts 931.02 + installation 2,110.00 + Mini Detail 200.00 + weld 60.00. */
export const ENGINE_JOB_WORK_CENTS = 480102

export interface EngineJob { orderId: string; estimateId: string; laborId: string; miniDetailId: string; weldId: string; enginePartId: string; partIds: string[] }

export async function seedEngineJob(opts: { orderNumber?: string; customerName?: string; actor?: string } = {}): Promise<EngineJob> {
  const db = getDb()
  const actor = opts.actor ?? 'Manager'
  const [v] = await db.insert(vehicles).values({ make: 'Chevrolet', model: 'Silverado 1500', year: '2004' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: opts.orderNumber ?? `ENG-${Math.floor(Math.random() * 1e9)}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived',
    customerName: opts.customerName ?? 'Fixture Customer',
  }).returning()
  const est = await getOrCreateEstimate(o.id, actor)

  const engine = await addEstimatePart(o.id, { description: 'Replacement engine', supply: 'shop', quantity: 1, sellPriceCents: 150000 }, actor)
  await decidePartLabor(o.id, engine.id, { action: 'add_labor', cents: ENGINE_JOB_LABOR_CENTS }, actor, 'manager')
  const [enginePart] = await db.select().from(jobParts).where(eq(jobParts.id, engine.id))

  const [mini] = await db.select({ id: serviceCatalog.id }).from(serviceCatalog).where(eq(serviceCatalog.slug, 'mini_detail'))
  const miniDetail = await addService(est.id, 'Mini Detail', { catalogId: mini.id, matchMethod: 'manual', actor })
  await setServicePrice(est.id, miniDetail.id, 20000, actor)
  const weld = await addService(est.id, 'EGR valve weld', { custom: true, actor })
  await setServicePrice(est.id, weld.id, 6000, actor)

  const partIds: string[] = []
  for (const [description, quantity, sellPriceCents] of ENGINE_JOB_PARTS) {
    partIds.push((await addEstimatePart(o.id, { description, supply: 'shop', quantity, sellPriceCents }, actor)).id)
  }
  return { orderId: o.id, estimateId: est.id, laborId: enginePart.laborServiceId!, miniDetailId: miniDetail.id, weldId: weld.id, enginePartId: engine.id, partIds }
}
