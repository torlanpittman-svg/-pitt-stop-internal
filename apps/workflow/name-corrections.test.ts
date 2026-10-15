/**
 * Estimate name corrections: customer-name spelling (renameOrderCustomer) and service-label
 * typo fixes (renameService). Driven against an in-memory PGlite pushed from the real Drizzle
 * schema, so the single-statement SQL is exercised for real.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

import { getOrCreateEstimate, promoteTextServices, setServicePrice, getEstimateView, prepareEstimateView, renameService, getFullEstimate } from '@/apps/workflow/estimate-db'
import { renameOrderCustomer, splitName, cleanCustomerName } from '@/apps/workflow/customer-name'
import { serviceOrders, vehicles, serviceOrderEvents, quickEntryJobs, customers, jobLineItems } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})

beforeEach(async () => {
  for (const t of ['job_line_items', 'job_services', 'job_estimates', 'service_order_events', 'quick_entry_jobs', 'service_orders', 'customers', 'vehicles']) {
    await db.execute(`DELETE FROM ${t}`)
  }
})

async function estimateOrder(opts: { name?: string; customerId?: string | null; services?: string[] } = {}) {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2020' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: `ES-TEST-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'estimate',
    customerName: opts.name ?? 'Jake Mixell', customerId: opts.customerId ?? null, services: opts.services ?? null,
  }).returning()
  await db.insert(quickEntryJobs).values({ serviceOrderId: o.id, vehicleId: v.id, customerName: opts.name ?? 'Jake Mixell', customerEmail: 'jake@example.com', customerPhone: '9795551234' })
  return { orderId: o.id, vehicleId: v.id }
}

describe('renameOrderCustomer — spelling fix keeps identity and links', () => {
  it('updates order, contact, and the linked directory customer in place (same ids), audited', async () => {
    const [c] = await db.insert(customers).values({ displayName: 'Jake Mixell', email: 'jake@example.com', source: 'quick_entry' }).returning()
    const { orderId, vehicleId } = await estimateOrder({ customerId: c.id })
    const r = await renameOrderCustomer(orderId, '  Jake   Mizell ', 'Manager')
    expect(r).toMatchObject({ changed: true, before: 'Jake Mixell', after: 'Jake Mizell', directoryCustomerId: c.id })

    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    expect(o).toMatchObject({ customerName: 'Jake Mizell', customerId: c.id, vehicleId, status: 'estimate' })
    const [qe] = await db.select().from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, orderId))
    expect(qe).toMatchObject({ customerName: 'Jake Mizell', customerEmail: 'jake@example.com', customerPhone: '9795551234' })
    const all = await db.select().from(customers)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: c.id, displayName: 'Jake Mizell', firstName: null, lastName: null, email: 'jake@example.com' })
    const events = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('customer_corrected')
    expect(JSON.parse(events[0].note!)).toMatchObject({ before: { name: 'Jake Mixell' }, after: { name: 'Jake Mizell' }, directoryCustomerId: c.id })
  })

  it('updates first/last when the directory stores them split', async () => {
    const [c] = await db.insert(customers).values({ firstName: 'Jake', lastName: 'Mixell', source: 'autoleap' }).returning()
    const { orderId } = await estimateOrder({ customerId: c.id })
    await renameOrderCustomer(orderId, 'Jake Mizell', 'Manager')
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id))
    expect(row).toMatchObject({ displayName: 'Jake Mizell', firstName: 'Jake', lastName: 'Mizell' })
  })

  it('never overwrites a linked directory profile that carries a different name', async () => {
    const [c] = await db.insert(customers).values({ displayName: 'Jacob Mizell Sr', source: 'autoleap' }).returning()
    const { orderId } = await estimateOrder({ customerId: c.id })
    const r = await renameOrderCustomer(orderId, 'Jake Mizell', 'Manager')
    expect(r.directoryCustomerId).toBeNull()
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id))
    expect(row.displayName).toBe('Jacob Mizell Sr')
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    expect(o.customerName).toBe('Jake Mizell')
  })

  it('works with no linked directory customer; unchanged name is a no-op; blank is rejected', async () => {
    const { orderId } = await estimateOrder()
    await renameOrderCustomer(orderId, 'Jake Mizell', 'Manager')
    expect((await renameOrderCustomer(orderId, 'Jake Mizell', 'Manager')).changed).toBe(false)
    expect(await db.select().from(serviceOrderEvents)).toHaveLength(1)
    await expect(renameOrderCustomer(orderId, '   ', 'Manager')).rejects.toThrow('Enter the customer name.')
  })

  it('splitName / cleanCustomerName', () => {
    expect(splitName('Jake Mizell')).toEqual({ first: 'Jake', last: 'Mizell' })
    expect(splitName('Mary Ann Smith')).toEqual({ first: 'Mary Ann', last: 'Smith' })
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: null })
    expect(() => cleanCustomerName('x'.repeat(201))).toThrow()
  })
})

describe('renameService — label fix keeps price, qty, and tax intact', () => {
  async function pricedEstimate() {
    const { orderId } = await estimateOrder({ services: ['Ful Detail', 'Wash'] })
    const est = await getOrCreateEstimate(orderId, 'Manager')
    await promoteTextServices(est.id, orderId)
    const view = await getEstimateView(orderId)
    const ful = view.services.find((s) => s.title === 'Ful Detail')!
    await setServicePrice(est.id, ful.id, 25000, 'Manager')
    await setServicePrice(est.id, view.services.find((s) => s.title === 'Wash')!.id, 4000, 'Manager')
    return { orderId, serviceId: ful.id }
  }

  it('renames the same service row; price line, qty, tax flags untouched; survives reopen', async () => {
    const { orderId, serviceId } = await pricedEstimate()
    const beforeLine = (await getFullEstimate(orderId))!.services.find((s) => s.id === serviceId)!.lines.find((l) => !l.generated)!
    await renameService(orderId, serviceId, 'Full Detail', 'Manager')

    // Reopen (page entry re-promotes the Job's text services) must not resurrect the old spelling.
    const view = await prepareEstimateView(orderId, 'Manager')
    expect(view.services.map((s) => [s.id, s.title, s.priceCents])).toEqual([
      [serviceId, 'Full Detail', 25000],
      [expect.any(String), 'Wash', 4000],
    ])
    expect(view.workTotalCents).toBe(29000)
    const [line] = await db.select().from(jobLineItems).where(eq(jobLineItems.id, beforeLine.id))
    expect(line).toMatchObject({ name: 'Full Detail', priceCents: beforeLine.priceCents, qty: beforeLine.qty, taxable: beforeLine.taxable, taxCategory: beforeLine.taxCategory, type: beforeLine.type })
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    expect(o.services).toEqual(['Full Detail', 'Wash'])
    const ev = (await db.select().from(serviceOrderEvents)).filter((e) => e.eventType === 'service_renamed')
    expect(ev).toHaveLength(1)
    expect(JSON.parse(ev[0].note!)).toMatchObject({ serviceId, from: 'Ful Detail', to: 'Full Detail' })
  })

  it('rejects blank, duplicate, and foreign services without changing anything', async () => {
    const { orderId, serviceId } = await pricedEstimate()
    await expect(renameService(orderId, serviceId, '  ', 'Manager')).rejects.toThrow('Enter a service name.')
    await expect(renameService(orderId, serviceId, 'wash', 'Manager')).rejects.toThrow('already has that name')
    const other = await estimateOrder()
    await expect(renameService(other.orderId, serviceId, 'Full Detail', 'Manager')).rejects.toThrow('does not belong')
    expect((await getEstimateView(orderId)).services.map((s) => s.title)).toEqual(['Ful Detail', 'Wash'])
  })

  it('allows a capitalization-only fix of the same service', async () => {
    const { orderId, serviceId } = await pricedEstimate()
    await renameService(orderId, serviceId, 'FUL DETAIL', 'Manager')
    expect((await getEstimateView(orderId)).services[0].title).toBe('FUL DETAIL')
  })
})
