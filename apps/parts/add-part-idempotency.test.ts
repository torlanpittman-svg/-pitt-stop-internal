/**
 * The Job screen's "add a part" is safe to repeat. On the real schema (in-memory PGlite):
 *   • the same logical add — sequential retry, overlapping requests, or a retry after the save succeeded but the
 *     response failed — yields ONE part, ONE estimate row, ONE priced line, ONE set of audit events, ONE charge;
 *   • two intentionally separate adds with identical details both land (a new form is a new request id);
 *   • the request id is scoped to its Job (the same id on another Job is a different add);
 *   • an add that is refused writes nothing and does not use up its request id;
 *   • a retry carrying different details than were saved changes nothing and says so (`differs`).
 * No real DB / QuickBooks / network.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { and, eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000, paymentEnabled: true, paymentBps: 300, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
// Fault injection for "saved, then the response failed": the derived-pricing step after the atomic write.
const fault = vi.hoisted(() => ({ settleFailures: 0 }))
vi.mock('@/apps/workflow/estimate-db', async (orig) => {
  const real = await orig<typeof import('@/apps/workflow/estimate-db')>()
  return {
    ...real,
    settlePricingAfterLineChange: async (...a: Parameters<typeof real.settlePricingAfterLineChange>) => {
      if (fault.settleFailures > 0) { fault.settleFailures--; throw new TypeError('fetch failed') }
      return real.settlePricingAfterLineChange(...a)
    },
  }
})

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, setServicePrice, setExplicitPrice, recomputeEstimate, getEstimateView, getEstimateRow } from '@/apps/workflow/estimate-db'
import { addPartForJobOnce, partIdForAddRequest, PartNotAddedError, removeEstimatePart } from './estimate-parts'
import { groupJobItems } from './job-items-view'
import { serviceOrders, vehicles, jobParts, jobLineItems, jobServices, serviceOrderEvents } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema }); holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]); await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
  fault.settleFailures = 0
})
afterEach(() => { fault.settleFailures = 0 })

const M = 'Manager'
async function job(services: Array<[string, number]> = [['Oil change', 6000]]) {
  const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Accord', year: '2019' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `IDEM-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'in_progress', customerName: 'Synthetic Customer', services: services.map(([t]) => t) }).returning()
  const est = await getOrCreateEstimate(o.id, M)
  const ids: string[] = []
  for (const [title, cents] of services) {
    const s = await addService(est.id, title, { actor: M })
    await setServicePrice(est.id, s.id, cents, M)
    ids.push(s.id)
  }
  return { orderId: o.id, estimateId: est.id, ids }
}
const PADS = { description: 'Brake pads', quantity: 2, sellPriceCents: 12550, partNumber: 'BP-1' }
const rid = (n: number) => `c3f1a9d2-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Everything an add creates, counted for one Job. */
async function footprint(orderId: string, estimateId: string) {
  const parts = await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId))
  const rows = await db.select().from(jobServices).where(and(eq(jobServices.jobEstimateId, estimateId), eq(jobServices.kind, 'part')))
  let lines = 0
  for (const r of rows) lines += (await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, r.id))).length
  const ev = async (type: string) => (await db.select().from(serviceOrderEvents).where(and(eq(serviceOrderEvents.serviceOrderId, orderId), eq(serviceOrderEvents.eventType, type)))).length
  const fees = (await db.select().from(jobLineItems).innerJoin(jobServices, eq(jobServices.id, jobLineItems.jobServiceId)).where(and(eq(jobServices.jobEstimateId, estimateId), eq(jobLineItems.generated, true)))).length
  return { parts: parts.length, live: parts.filter((p) => p.status !== 'cancelled').length, partRows: rows.length, partLines: lines, added: await ev('part_added'), labor: await ev('part_labor_review'), feeLines: fees }
}
const ONE = { parts: 1, live: 1, partRows: 1, partLines: 1, added: 1 }

describe('the request id is the add’s identity on its Job', () => {
  it('is a stable UUID per (Job, request id) and different for another Job or another request', () => {
    const a = partIdForAddRequest('job-1', rid(1))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(partIdForAddRequest('job-1', rid(1))).toBe(a)
    expect(partIdForAddRequest('job-2', rid(1))).not.toBe(a)
    expect(partIdForAddRequest('job-1', rid(2))).not.toBe(a)
  })
})

describe('the same logical add never lands twice', () => {
  it('a sequential retry returns the original part: one part, one line, one audit trail, one charge', async () => {
    const { orderId, estimateId, ids } = await job()
    const a = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(1) }, M, 'manager', ids[0])
    const total1 = (await getEstimateRow(orderId))!.totalCents
    const b = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(1) }, M, 'manager', ids[0])
    expect(a).toMatchObject({ replayed: false, differs: false, removed: false })
    expect(b).toMatchObject({ replayed: true, differs: false, removed: false })
    expect(b.part.id).toBe(a.part.id)
    expect(a.part.id).toBe(partIdForAddRequest(orderId, rid(1)))
    expect(await footprint(orderId, estimateId)).toMatchObject({ ...ONE, labor: 1, feeLines: 2 })
    expect((await getEstimateView(orderId)).workTotalCents).toBe(6000 + 25100)
    expect((await getEstimateRow(orderId))!.totalCents).toBe(total1)
  })

  it('FIVE overlapping identical requests: exactly one writes, the others return the same part', async () => {
    const { orderId, estimateId, ids } = await job()
    const results = await Promise.all(Array.from({ length: 5 }, () => addPartForJobOnce(orderId, { ...PADS, requestId: rid(2) }, M, 'manager', ids[0])))
    expect(new Set(results.map((r) => r.part.id)).size).toBe(1)
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(results.every((r) => !r.differs && !r.removed)).toBe(true)
    expect(await footprint(orderId, estimateId)).toMatchObject({ ...ONE, labor: 1, feeLines: 2 })
    const view = await getEstimateView(orderId)
    expect(view.workTotalCents).toBe(6000 + 25100)
    expect(groupJobItems(view).services[0].parts.map((p) => [p.description, p.quantity, p.lineCents])).toEqual([['Brake pads', 2, 25100]])
  })

  it('saved, then the response failed (the step after the write threw): the part is there once, and the retry returns it and repairs the totals', async () => {
    const { orderId, estimateId } = await job()
    const before = (await getEstimateRow(orderId))!.totalCents
    fault.settleFailures = 2   // the first attempt and its one internal second try
    const first = addPartForJobOnce(orderId, { ...PADS, requestId: rid(3) }, M, 'manager')
    await expect(first).rejects.toThrow()
    await expect(first).rejects.not.toBeInstanceOf(PartNotAddedError)   // NOT reported as "nothing saved"
    expect(await footprint(orderId, estimateId)).toMatchObject(ONE)
    expect((await getEstimateRow(orderId))!.totalCents).toBe(before)     // derived totals never ran

    const retry = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(3) }, M, 'manager')
    expect(retry).toMatchObject({ replayed: true, differs: false, removed: false })
    expect(await footprint(orderId, estimateId)).toMatchObject({ ...ONE, labor: 0, feeLines: 2 })
    const work = 6000 + 25100
    expect((await getEstimateView(orderId)).workTotalCents).toBe(work)
    // 3% shop supplies + 3% card charge on the work value, each once.
    expect((await getEstimateRow(orderId))!.totalCents).toBe(work + Math.round(work * 0.03) * 2)
  })

  it('an overlapping retry racing a first attempt whose post-write step fails still ends with one part and correct totals', async () => {
    const { orderId, estimateId } = await job()
    fault.settleFailures = 1   // absorbed by the internal second try
    const [a, b] = await Promise.all([
      addPartForJobOnce(orderId, { ...PADS, requestId: rid(4) }, M, 'manager'),
      addPartForJobOnce(orderId, { ...PADS, requestId: rid(4) }, M, 'manager'),
    ])
    expect(a.part.id).toBe(b.part.id)
    expect(await footprint(orderId, estimateId)).toMatchObject({ ...ONE, feeLines: 2 })
    expect((await getEstimateView(orderId)).workTotalCents).toBe(6000 + 25100)
  })
})

describe('separate additions stay separate', () => {
  it('two forms with identical details (different request ids) are two parts and two charges', async () => {
    const { orderId, estimateId, ids } = await job()
    const a = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(10) }, M, 'manager', ids[0])
    const b = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(11) }, M, 'manager', ids[0])
    expect(b.part.id).not.toBe(a.part.id)
    expect(b.replayed).toBe(false)
    expect(await footprint(orderId, estimateId)).toMatchObject({ parts: 2, live: 2, partRows: 2, partLines: 2, added: 2, labor: 2 })
    expect((await getEstimateView(orderId)).workTotalCents).toBe(6000 + 25100 * 2)
  })

  it('without a request id every call is its own add', async () => {
    const { orderId, estimateId } = await job()
    await addPartForJobOnce(orderId, PADS, M, 'manager')
    await addPartForJobOnce(orderId, PADS, M, 'manager')
    expect(await footprint(orderId, estimateId)).toMatchObject({ parts: 2, partLines: 2, added: 2 })
  })

  it('the same request id on a DIFFERENT Job is a different add (identity is scoped to the Job)', async () => {
    const one = await job()
    const two = await job()
    const a = await addPartForJobOnce(one.orderId, { ...PADS, requestId: rid(12) }, M, 'manager')
    const b = await addPartForJobOnce(two.orderId, { ...PADS, requestId: rid(12) }, M, 'manager')
    expect(b.replayed).toBe(false)
    expect(b.part.id).not.toBe(a.part.id)
    expect(b.part.serviceOrderId).toBe(two.orderId)
    expect(await footprint(one.orderId, one.estimateId)).toMatchObject(ONE)
    expect(await footprint(two.orderId, two.estimateId)).toMatchObject(ONE)
  })
})

describe('duplicate service names', () => {
  it('overlapping adds to the SECOND of two same-named services attach by id, once', async () => {
    const { orderId, estimateId, ids } = await job([['Oil change', 6000], ['Oil change', 7000]])
    expect(ids[0]).not.toBe(ids[1])
    const [a, b] = await Promise.all([
      addPartForJobOnce(orderId, { ...PADS, requestId: rid(20) }, M, 'manager', ids[1]),
      addPartForJobOnce(orderId, { ...PADS, requestId: rid(20) }, M, 'manager', ids[1]),
    ])
    expect(a.part.id).toBe(b.part.id)
    expect(a.part.laborServiceId).toBe(ids[1])
    const g = groupJobItems(await getEstimateView(orderId))
    expect(g.services.find((s) => s.id === ids[1])!.parts.map((p) => p.description)).toEqual(['Brake pads'])
    expect(g.services.find((s) => s.id === ids[0])!.parts).toEqual([])
    expect(g.standalone).toEqual([])
    expect(await footprint(orderId, estimateId)).toMatchObject({ ...ONE, labor: 1 })
  })
})

describe('a retry that is not the same submission', () => {
  it('changed quantity / price / name / assignment after the first try saved: nothing changes, and the result says it differs', async () => {
    const { orderId, estimateId, ids } = await job([['Oil change', 6000], ['Wiper service', 2000]])
    const first = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(30) }, M, 'manager', ids[0])
    for (const [input, attach] of [
      [{ ...PADS, quantity: 3 }, ids[0]],
      [{ ...PADS, sellPriceCents: 9900 }, ids[0]],
      [{ ...PADS, description: 'Brake pads (rear)' }, ids[0]],
      [PADS, ids[1]],
      [PADS, null],
      [{ ...PADS, quantity: 'abc' }, ids[0]],   // even an invalid edit is answered with the saved part, not an error
    ] as const) {
      const r = await addPartForJobOnce(orderId, { ...input, requestId: rid(30) } as Parameters<typeof addPartForJobOnce>[1], M, 'manager', attach)
      expect(r).toMatchObject({ replayed: true, differs: true, removed: false })
      expect(r.part.id).toBe(first.part.id)
    }
    const [saved] = await db.select().from(jobParts).where(eq(jobParts.id, first.part.id))
    expect([saved.description, Number(saved.quantity), saved.sellPriceCents, saved.laborServiceId]).toEqual(['Brake pads', 2, 12550, ids[0]])
    expect(await footprint(orderId, estimateId)).toMatchObject({ ...ONE, labor: 1 })
    expect((await getEstimateView(orderId)).workTotalCents).toBe(6000 + 2000 + 25100)
  })

  it('an employee’s identical retry is not "different" because our cost was dropped; the cost never reaches the record', async () => {
    const { orderId } = await job()
    const input = { ...PADS, unitCostCents: 4000, requestId: rid(31) }
    const a = await addPartForJobOnce(orderId, input, 'Employee', 'employee')
    const b = await addPartForJobOnce(orderId, input, 'Employee', 'employee')
    expect(a.part.unitCostCents).toBeNull()
    expect(b).toMatchObject({ replayed: true, differs: false })
  })

  it('retrying after the part was removed reports that, and adds nothing back', async () => {
    const { orderId, estimateId } = await job()
    const a = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(32) }, M, 'manager')
    await removeEstimatePart(orderId, a.part.id, M)
    const b = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(32) }, M, 'manager')
    expect(b).toMatchObject({ replayed: true, removed: true })
    expect(await footprint(orderId, estimateId)).toMatchObject({ parts: 1, live: 0, partRows: 0, partLines: 0, added: 1 })
    expect((await getEstimateView(orderId)).workTotalCents).toBe(6000)
  })
})

describe('a refused add leaves nothing behind and does not use up its request id', () => {
  const expectNothing = async (orderId: string, estimateId: string) =>
    expect(await footprint(orderId, estimateId)).toMatchObject({ parts: 0, partRows: 0, partLines: 0, added: 0, labor: 0 })

  it('a service that is not on the Job: refused as not-saved; the same form re-sent to Whole job then saves as a FIRST save', async () => {
    const { orderId, estimateId } = await job()
    const gone = '11111111-2222-4333-8444-555555555555'
    const refused = addPartForJobOnce(orderId, { ...PADS, requestId: rid(40) }, M, 'manager', gone)
    await expect(refused).rejects.toBeInstanceOf(PartNotAddedError)
    await expect(refused).rejects.toThrow(/no longer on this job/)
    await expectNothing(orderId, estimateId)
    const ok = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(40) }, M, 'manager')
    expect(ok).toMatchObject({ replayed: false, differs: false })
    expect(await footprint(orderId, estimateId)).toMatchObject(ONE)
  })

  it('a part’s own estimate row can never be the service it attaches to', async () => {
    const { orderId, estimateId } = await job()
    const a = await addPartForJobOnce(orderId, { ...PADS, requestId: rid(41) }, M, 'manager')
    await expect(addPartForJobOnce(orderId, { description: 'Clip', quantity: 1, sellPriceCents: 100, requestId: rid(42) }, M, 'manager', a.part.jobServiceId!)).rejects.toBeInstanceOf(PartNotAddedError)
    expect(await footprint(orderId, estimateId)).toMatchObject(ONE)
  })

  it('missing / invalid price or quantity: refused before anything is written', async () => {
    const { orderId, estimateId } = await job()
    for (const bad of [{ sellPriceCents: null }, { sellPriceCents: '' }, { sellPriceCents: -1 }, { sellPriceCents: 'abc' }, { quantity: 0 }, { quantity: 'x' }, { description: '   ' }]) {
      await expect(addPartForJobOnce(orderId, { ...PADS, ...bad, requestId: rid(43) } as Parameters<typeof addPartForJobOnce>[1], M, 'manager')).rejects.toBeInstanceOf(PartNotAddedError)
    }
    await expectNothing(orderId, estimateId)
  })

  it('the write itself re-checks the Job: a Job removed just before the write gets no part (decided inside the statement)', async () => {
    const { orderId, estimateId } = await job()
    await db.update(serviceOrders).set({ status: 'cancelled' }).where(eq(serviceOrders.id, orderId))
    const refused = addPartForJobOnce(orderId, { ...PADS, requestId: rid(44) }, M, 'manager')
    await expect(refused).rejects.toBeInstanceOf(PartNotAddedError)
    await expect(refused).rejects.toThrow(/job was removed/)
    await expectNothing(orderId, estimateId)
  })

  it('an employee cannot itemize a flat-priced Job by adding a part: refused, nothing written, price untouched', async () => {
    const { orderId, estimateId } = await job()
    await setExplicitPrice(estimateId, 15000, M); await recomputeEstimate(estimateId)
    await expect(addPartForJobOnce(orderId, { ...PADS, requestId: rid(45) }, 'Employee', 'employee')).rejects.toBeInstanceOf(PartNotAddedError)
    await expectNothing(orderId, estimateId)
    expect((await getEstimateRow(orderId))!).toMatchObject({ priceMode: 'explicit_pretax', explicitTotalCents: 15000 })
  })

  it('a driver / network failure before the write is not-saved too, with a neutral message (no raw error text)', async () => {
    const { orderId, estimateId } = await job()
    const real = holder.db
    holder.db = new Proxy(real as object, { get: (t, k, r) => (k === 'select' ? () => { throw new TypeError('fetch failed 10.1.2.3') } : Reflect.get(t, k, r)) }) as typeof real
    try {
      const refused = addPartForJobOnce(orderId, PADS, M, 'manager')
      await expect(refused).rejects.toBeInstanceOf(PartNotAddedError)
      await expect(refused).rejects.toThrow(/nothing was saved/)
    } finally { holder.db = real }
    await expectNothing(orderId, estimateId)
  })
})
