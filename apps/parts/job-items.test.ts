/**
 * Services vs Parts on a Job (Job page, Work Board card, Finish Job gate). Reference case (2026-10-20,
 * Tim Schnabel 2015 Jeep Wrangler): a 2026-09-23 standalone estimate typed seven carpets/filter as
 * SERVICE rows (labor lines, no job_parts), and conversion copied every approved title — parts included —
 * into the Job's Services list. Classification must come from records (job_parts / kind='part'), never
 * from wording; correcting a line uses the existing convertServiceToPart; nothing is billed twice.
 * In-memory PGlite from the real Drizzle schema + production-shaped catalog. No real DB/QB/network.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, setServicePrice, getEstimateView, convertEstimate, setApproval, prepareEstimateView } from '@/apps/workflow/estimate-db'
import { convertServiceToPart, addEstimatePart } from '@/apps/parts/estimate-parts'
import { getOrderWithContext, transitionOrder } from '@/apps/workflow/db'
import { splitJobItems, loadJobItems } from './job-items'
import { summarizeParts } from './status'
import { listPartsForOrder, cancelPart, receivePart, markOrdered } from './db'
import { serviceOrders, vehicles, jobParts, jobLineItems, serviceOrderEvents } from '@/drizzle/schema'

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
afterEach(() => { delete process.env.ESTIMATE_CONVERT_SYNCS_SERVICES })

async function order(services: string[] = [], status = 'arrived') {
  const [v] = await db.insert(vehicles).values({ make: 'Jeep', model: 'Wrangler', year: '2015' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `JI-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status, customerName: 'Test Customer', services }).returning()
  const est = await getOrCreateEstimate(o.id, 'Manager')
  return { orderId: o.id, estimateId: est.id }
}
const WORK = ['Carpet removal', 'Clean and sanitize floor pan', 'Interior detail']
const PARTS = ['Front left carpet — 5PL371X9AB (qty 1, list price)', 'Cabin Air filter']
const text = async (orderId: string) => (await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId)))[0].services

describe('splitJobItems (pure)', () => {
  it('only labels that match a real part record are parts; order is kept; wording alone never decides', () => {
    const keys = new Set(['cabin air filter'])
    expect(splitJobItems(['Interior detail', ' Cabin Air filter ', 'Front left carpet'], keys))
      .toEqual({ services: ['Interior detail', 'Front left carpet'], partLabels: [' Cabin Air filter '] })
    expect(splitJobItems(null, keys)).toEqual({ services: [], partLabels: [] })
  })
})

describe('Schnabel-shaped Job — parts typed as services', () => {
  /** Recreate the legacy shape: every line a SERVICE with a labor price, all on the Job list. */
  async function legacyJob() {
    const { orderId, estimateId } = await order([...WORK, ...PARTS])
    await prepareEstimateView(orderId, 'Manager')
    const view = await getEstimateView(orderId)
    const prices = [75000, 30000, 30000, 30400, 8900]
    for (const [i, s] of view.services.entries()) await setServicePrice(estimateId, s.id, prices[i], 'Manager')
    return { orderId, estimateId }
  }

  it('before correction everything is (wrongly) work — the classification does not guess from names', async () => {
    const { orderId } = await legacyJob()
    const items = (await loadJobItems([{ id: orderId, services: await text(orderId) }])).get(orderId)!
    expect(items.services).toEqual([...WORK, ...PARTS])
    expect(items.parts).toEqual({ total: 0, waiting: 0 })
  })

  it('converting a line to a part moves it to Parts on the Job page/card, keeps the money identical, and bills it once', async () => {
    const { orderId } = await legacyJob()
    const before = await getEstimateView(orderId)
    // The wording check alone can't tell "Front left carpet — 5PL…" is a part, so an UNconfirmed conversion
    // still refuses (never silent) — staff correct it with an explicit confirmation.
    const carpet = (await getEstimateView(orderId)).services.find((x) => x.title === PARTS[0])!
    await expect(convertServiceToPart(orderId, carpet.id, { supply: 'shop' }, 'Manager')).rejects.toThrow(/describes work/)
    for (const title of PARTS) {
      const s = (await getEstimateView(orderId)).services.find((x) => x.title === title)!
      await convertServiceToPart(orderId, s.id, { supply: 'shop', confirmed: true }, 'Manager')
    }
    const o = (await getOrderWithContext(orderId))!
    expect(o.items!.services).toEqual(WORK)
    expect(o.items!.partLabels).toEqual(PARTS)
    expect(o.items!.parts).toEqual({ total: 2, waiting: 2 })   // 'needed' parts are outstanding
    const after = await getEstimateView(orderId)
    expect(after.workTotalCents).toBe(before.workTotalCents)   // same price lines, re-labelled — not re-added
    expect(after.services.map((s) => s.title)).toEqual(WORK)
    expect(after.parts!.map((p) => p.lineCents)).toEqual([30400, 8900])
    expect((await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId)))).toHaveLength(2)
    // Reopening the estimate never re-creates the converted parts as services, nor duplicates the Job list.
    await prepareEstimateView(orderId, 'Manager')
    expect((await getEstimateView(orderId)).services.map((s) => s.title)).toEqual(WORK)
    expect(await text(orderId)).toEqual([...WORK, ...PARTS])
  })

  it('the Finish Job gate counts work only (a parts-only list cannot be "finished" as work)', async () => {
    const { orderId } = await order(['Cabin Air filter'])
    await addEstimatePart(orderId, { description: 'Cabin Air filter', supply: 'shop' }, 'Manager')
    const o = (await getOrderWithContext(orderId))!
    expect(o.items!.services).toEqual([])
    expect(o.items!.partLabels).toEqual(['Cabin Air filter'])
  })
})

describe('estimate → Work Board conversion no longer copies parts into Services', () => {
  it('approved parts stay Parts; approved work is synced once', async () => {
    process.env.ESTIMATE_CONVERT_SYNCS_SERVICES = 'true'
    const { orderId, estimateId } = await order([], 'estimate')
    const work = await addService(estimateId, 'Carpet removal', { actor: 'Manager' })
    await setServicePrice(estimateId, work.id, 75000, 'Manager')
    await addEstimatePart(orderId, { description: 'Front left carpet', supply: 'shop' }, 'Manager')
    for (const s of (await getEstimateView(orderId)).services) await setApproval(estimateId, orderId, s.id, 'approved', 'Manager')
    await convertEstimate(estimateId, orderId, 'Manager')
    expect(await text(orderId)).toEqual(['Carpet removal'])
  })
})

describe('Finish Job — duplicate submits complete once', () => {
  it('a repeat ready → ready is an idempotent success: one completion event, completed_at unchanged', async () => {
    const { orderId } = await order(['Interior detail'], 'in_progress')
    const first = await transitionOrder({ orderId, newStatus: 'ready', employeeName: 'Tony', completedBy: 'Tony', completionChecklist: { allWorkComplete: true } })
    expect(first.ok).toBe(true)
    const stamped = first.order!.completedAt
    const again = await transitionOrder({ orderId, newStatus: 'ready', employeeName: 'Darryl', completedBy: 'Darryl', completionChecklist: { allWorkComplete: true } })
    expect(again.ok).toBe(true)
    expect(again.order!.completedAt).toEqual(stamped)
    expect(again.order!.completedBy).toBe('Tony')
    const evs = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))
    expect(evs.filter((e) => e.eventType === 'completed')).toHaveLength(1)
    expect(evs.filter((e) => e.eventType === 'status_changed')).toHaveLength(1)
  })

  it('two concurrent submits produce exactly one completion', async () => {
    const { orderId } = await order(['Interior detail'], 'in_progress')
    const [a, b] = await Promise.all([
      transitionOrder({ orderId, newStatus: 'ready', employeeName: 'Tony', completedBy: 'Tony', completionChecklist: { allWorkComplete: true } }),
      transitionOrder({ orderId, newStatus: 'ready', employeeName: 'Darryl', completedBy: 'Darryl', completionChecklist: { allWorkComplete: true } }),
    ])
    expect(a.ok && b.ok).toBe(true)
    const evs = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))
    expect(evs.filter((e) => e.eventType === 'completed')).toHaveLength(1)
  })

  it('no line items are touched by completion', async () => {
    const { orderId, estimateId } = await order(['Interior detail'], 'in_progress')
    await prepareEstimateView(orderId, 'Manager')
    const s = (await getEstimateView(orderId)).services[0]
    await setServicePrice(estimateId, s.id, 30000, 'Manager')
    const lines = await db.select().from(jobLineItems)
    await transitionOrder({ orderId, newStatus: 'ready', employeeName: 'Tony', completedBy: 'Tony', completionChecklist: { allWorkComplete: true } })
    expect(await db.select().from(jobLineItems)).toEqual(lines)
  })
})

describe('live Parts summary == a fresh page load (client update vs server loader)', () => {
  it('after each tracker change, the client summary equals what reopening the Job shows', async () => {
    const { orderId } = await order(['Interior detail'])
    const check = async () => {
      const live = summarizeParts(await listPartsForOrder(orderId))          // what PartsSection reports up
      const fresh = (await getOrderWithContext(orderId))!.items!.parts      // what a reload / reopen shows
      expect(live).toEqual(fresh)
      return live
    }
    await addEstimatePart(orderId, { description: 'Front carpet', supply: 'shop' }, 'Manager')
    expect(await check()).toEqual({ total: 1, waiting: 1 })
    await addEstimatePart(orderId, { description: 'Cabin Air filter', supply: 'shop' }, 'Manager')
    expect(await check()).toEqual({ total: 2, waiting: 2 })
    const [a, b] = await listPartsForOrder(orderId)
    expect((await markOrdered(a.id, { supplier: 'Dealer' })).ok).toBe(true)
    expect((await receivePart(a.id, 1)).ok).toBe(true)
    expect(await check()).toEqual({ total: 2, waiting: 1 })
    await cancelPart(b.id, 'Manager')
    expect(await check()).toEqual({ total: 1, waiting: 0 })
  })
})
