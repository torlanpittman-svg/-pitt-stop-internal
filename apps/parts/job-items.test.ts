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
import { getOrderWithContext, transitionOrder, listActiveOrders } from '@/apps/workflow/db'
import { splitJobItems, loadJobItems } from './job-items'
import { summarizeParts, countJobParts } from './status'
import { listPartsForOrder, cancelPart, receivePart, markOrdered, addPart } from './db'
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

/** The figure each view actually renders: Job page (server items, and the client's live recount from the
 *  tracker list) and the Work Board card (listActiveOrders items). All three must agree. */
async function displayed(orderId: string) {
  const job = (await getOrderWithContext(orderId))!.items!
  const card = (await listActiveOrders()).find((o) => o.id === orderId)!.items!
  const live = countJobParts(job.partLabels, await listPartsForOrder(orderId))
  expect(card.parts).toEqual(job.parts)
  expect({ total: live.total, waiting: live.waiting }).toEqual(job.parts)
  expect(live.activeLabels).toEqual(job.activePartLabels)
  return { ...job.parts, services: job.services, activeLabels: job.activePartLabels }
}

describe('displayed Parts count — one rule for the Job page and the Work Board card', () => {
  it('Codex repro: a converted legacy part that is then cancelled counts ZERO (and stays out of Services)', async () => {
    const { orderId } = await order(['Interior detail', 'Cabin Air filter'], 'in_progress')
    await prepareEstimateView(orderId, 'Manager')
    const filter = (await getEstimateView(orderId)).services.find((x) => x.title === 'Cabin Air filter')!
    await convertServiceToPart(orderId, filter.id, { supply: 'shop', confirmed: true }, 'Manager')
    expect(await displayed(orderId)).toMatchObject({ total: 1, waiting: 1, activeLabels: ['Cabin Air filter'] })
    const before = await getEstimateView(orderId)
    const lines = await db.select().from(jobLineItems)
    const [p] = await listPartsForOrder(orderId)
    await cancelPart(p.id, 'Manager')
    expect(await displayed(orderId)).toEqual({ total: 0, waiting: 0, services: ['Interior detail'], activeLabels: [] })
    expect(await listPartsForOrder(orderId)).toHaveLength(1)                       // still in the tracker history
    expect(await text(orderId)).toEqual(['Interior detail', 'Cabin Air filter'])    // Job text untouched
    expect((await getEstimateView(orderId)).workTotalCents).toBe(before.workTotalCents) // prices untouched
    expect(await db.select().from(jobLineItems)).toEqual(lines)                     // billing lines untouched
  })

  it('mixed tracked + untracked parts: untracked labels still count, tracked ones once', async () => {
    const { orderId, estimateId } = await order(['Interior detail', 'Wiper blades', 'Front carpet'])
    // "Wiper blades": an estimate line typed as a part, never tracked → a legitimate untracked part.
    await db.execute(`INSERT INTO job_services(job_estimate_id, title, kind, source, sort_order) VALUES ('${estimateId}', 'Wiper blades', 'part', 'manual', 9)`)
    // "Front carpet": tracked (Quick Entry-style job_parts row), plus a second tracked part not on the text list.
    await addPart({ serviceOrderId: orderId, description: 'Front carpet' })
    const clip = await addPart({ serviceOrderId: orderId, description: 'Clip' })
    expect(await displayed(orderId)).toMatchObject({ total: 3, waiting: 2, services: ['Interior detail'], activeLabels: ['Wiper blades', 'Front carpet'] })
    await cancelPart(clip.id, 'Manager')
    expect(await displayed(orderId)).toMatchObject({ total: 2, waiting: 1 })
  })

  it('duplicate labels for the same part count once — with or without a tracked record', async () => {
    const { orderId } = await order(['Cabin Air filter', ' cabin air filter ', 'Interior detail'])
    await addPart({ serviceOrderId: orderId, description: 'Cabin Air filter' })
    expect(await displayed(orderId)).toMatchObject({ total: 1, waiting: 1, activeLabels: ['Cabin Air filter'] })
    expect(countJobParts(['Mat', 'mat ', 'Mat'], [])).toEqual({ total: 1, waiting: 0, activeLabels: ['Mat'] })
  })

  it('a re-added part after a cancelled one counts again (live record wins over the cancelled one)', async () => {
    const { orderId } = await order(['Cabin Air filter'])
    const first = await addPart({ serviceOrderId: orderId, description: 'Cabin Air filter' })
    await cancelPart(first.id, 'Manager')
    expect(await displayed(orderId)).toMatchObject({ total: 0, activeLabels: [] })
    await addPart({ serviceOrderId: orderId, description: 'Cabin Air filter' })
    expect(await displayed(orderId)).toMatchObject({ total: 1, waiting: 1, activeLabels: ['Cabin Air filter'] })
  })

  it('dealer Jobs use the same rule (no retail coupling)', async () => {
    const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2020' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: `JI-${++seq}`, vehicleId: v.id, source: 'dealer_checkin', serviceType: 'dealer_in', status: 'arrived', customerName: 'Dealer', services: ['Complete Detail'] }).returning()
    expect(await displayed(o.id)).toMatchObject({ total: 0, waiting: 0, services: ['Complete Detail'] })
  })
})
