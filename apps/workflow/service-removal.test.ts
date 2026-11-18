/**
 * Service removal must affect exactly the selected line. Identical names appear
 * legitimately (the add route confirms duplicates), and the legacy normalized-name
 * filter removed ALL of them at once. Billing rows come in BOTH legacy shapes: a fresh
 * promoteTextServices of a duplicated list creates one job_services row per occurrence
 * (sort_order = text index), while promoting again after a confirmed duplicate was
 * added leaves ONE shared row. These tests cover the pure resolvers and drive the REAL
 * removeServiceFromJob against an in-memory PGlite Postgres (schema pushed from the
 * actual Drizzle schema): one occurrence and at most one billing row per removal,
 * covered part labor reopens exactly when its bill row is deleted, ambiguous mappings
 * mutate nothing, stale/retried requests mutate nothing, and other rows/orders, job
 * status, and completedAt are untouched. No QuickBooks/network calls exist in this path.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

// Imported after the mock is registered (vi.mock is hoisted).
import { resolveServiceRemoval, resolveBillRowMapping, mapDisplayedIndexToRaw } from '@/apps/workflow/service-removal'
import { getOrCreateEstimate, promoteTextServices, recomputeEstimate, removeServiceFromJob, addLine } from '@/apps/workflow/estimate-db'
import { serviceOrders, vehicles, jobServices, jobLineItems, jobParts, serviceOrderEvents } from '@/drizzle/schema'
import { eq, and, ne, asc } from 'drizzle-orm'

let db: PgliteDatabase<typeof schema>
let orderSeq = 0

async function newRetailOrder(services: string[], extra: Partial<typeof serviceOrders.$inferInsert> = {}): Promise<string> {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'Transit', year: '2021' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: `SO-TEST-${++orderSeq}`, vehicleId: v.id,
    source: 'quick_entry', serviceType: 'retail', status: 'arrived', services, ...extra,
  }).returning()
  return o.id
}

/** Build the estimate mirror for an order and return its id. */
async function mirrorEstimate(orderId: string): Promise<string> {
  const est = await getOrCreateEstimate(orderId, 'Test Manager')
  await promoteTextServices(est.id, orderId)
  await recomputeEstimate(est.id)
  return est.id
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  return row
}

/** Non-system billing rows for an estimate, in stable sort_order. */
async function billRows(estimateId: string, title?: string) {
  const rows = await db.select().from(jobServices)
    .where(and(eq(jobServices.jobEstimateId, estimateId), ne(jobServices.source, 'system')))
    .orderBy(asc(jobServices.sortOrder))
  return title ? rows.filter((r) => r.title === title) : rows
}

async function estimateServiceTitles(estimateId: string): Promise<string[]> {
  return (await billRows(estimateId)).map((r) => r.title).sort()
}

async function linesOf(jobServiceId: string) {
  return db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, jobServiceId))
}

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  // pushSchema types the db arg with the default (empty) schema; our fully-typed instance is
  // structurally compatible at runtime, so bridge the generic without using `any`.
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})

beforeEach(async () => {
  for (const t of ['job_parts', 'job_line_items', 'job_services', 'job_estimates', 'service_order_events', 'service_orders', 'vehicles', 'service_catalog', 'service_price_tiers', 'service_aliases']) {
    await db.execute(`DELETE FROM ${t}`)
  }
})

describe('resolveServiceRemoval — exactly one occurrence, never a guess', () => {
  it('single match needs no hints', () => {
    expect(resolveServiceRemoval(['Wash', 'Polish'], 'Polish'))
      .toEqual({ outcome: 'remove', index: 1, next: ['Wash'], ordinal: 0, occurrenceCount: 1, lastOccurrence: true })
  })
  it('matches case/whitespace-insensitively', () => {
    expect(resolveServiceRemoval(['Wash'], '  wAsH ')).toMatchObject({ outcome: 'remove', index: 0 })
  })
  it('duplicates + a valid index remove exactly that occurrence, reporting its ordinal', () => {
    const r = resolveServiceRemoval(['Wash', 'Polish', 'Wash'], 'Wash', { index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })
    expect(r).toEqual({ outcome: 'remove', index: 2, next: ['Wash', 'Polish'], ordinal: 1, occurrenceCount: 2, lastOccurrence: false })
  })
  it('removing the final remaining occurrence reports lastOccurrence', () => {
    const r = resolveServiceRemoval(['Wash', 'Polish'], 'Wash', { index: 0, expectedServices: ['Wash', 'Polish'] })
    expect(r).toMatchObject({ outcome: 'remove', ordinal: 0, occurrenceCount: 1, lastOccurrence: true })
  })
  it('duplicates WITHOUT a trustworthy index are stale — never remove all, never guess', () => {
    expect(resolveServiceRemoval(['Wash', 'Wash'], 'Wash')).toEqual({ outcome: 'stale' })
    expect(resolveServiceRemoval(['Wash', 'Wash'], 'Wash', { index: 5 })).toEqual({ outcome: 'stale' })
  })
  it('a snapshot that no longer matches (retried/duplicated request) is stale', () => {
    // First removal of index 2 already succeeded; the retry must not take the remaining Wash.
    expect(resolveServiceRemoval(['Wash', 'Polish'], 'Wash', { index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })).toEqual({ outcome: 'stale' })
  })
  it('an index pointing at a different name falls back safely to the single match', () => {
    expect(resolveServiceRemoval(['Wash', 'Polish'], 'Polish', { index: 0 })).toMatchObject({ outcome: 'remove', index: 1 })
  })
  it('unknown or empty names are not_found', () => {
    expect(resolveServiceRemoval(['Wash'], 'Wax')).toEqual({ outcome: 'not_found' })
    expect(resolveServiceRemoval(['Wash'], '   ')).toEqual({ outcome: 'not_found' })
  })
})

describe('mapDisplayedIndexToRaw — the classified (filtered) list never mistargets a raw occurrence', () => {
  it('identical lists map 1:1', () => {
    expect(mapDisplayedIndexToRaw(['Wash', 'Polish'], 1, ['Wash', 'Polish'])).toBe(1)
  })
  it('REGRESSION (browser-reproduced): hidden leading entry — the second displayed Wash is raw index 2, not 1', () => {
    const raw = ['Hidden part', 'Wash', 'Wash']
    const displayed = ['Wash', 'Wash']
    expect(mapDisplayedIndexToRaw(displayed, 1, raw)).toBe(2)
    expect(mapDisplayedIndexToRaw(displayed, 0, raw)).toBe(1)
  })
  it('hidden entries interleaved between duplicates still map by occurrence ordinal', () => {
    expect(mapDisplayedIndexToRaw(['Wash', 'Wash'], 1, ['Wash', 'Hidden part', 'Wash'])).toBe(2)
  })
  it('same-name counts that disagree fail closed (never guess from a deduped/filtered view)', () => {
    // The display dropped one Wash — which raw occurrence the user means is unknowable.
    expect(mapDisplayedIndexToRaw(['Wash', 'Wash'], 1, ['Wash', 'Wash', 'Wash'])).toBeNull()
    expect(mapDisplayedIndexToRaw(['Wash', 'Wash'], 0, ['Wash'])).toBeNull()
  })
  it('a displayed name missing from the raw list fails closed', () => {
    expect(mapDisplayedIndexToRaw(['Wash'], 0, ['Polish'])).toBeNull()
  })
  it('out-of-range or blank selections fail closed', () => {
    expect(mapDisplayedIndexToRaw(['Wash'], 3, ['Wash'])).toBeNull()
    expect(mapDisplayedIndexToRaw(['  '], 0, ['  '])).toBeNull()
  })
  it('matches case/whitespace-insensitively across the two lists', () => {
    expect(mapDisplayedIndexToRaw(['wash '], 0, ['Hidden part', ' Wash'])).toBe(1)
  })
})

describe('resolveBillRowMapping — at most one billing row, fail closed on doubt', () => {
  const occ = (ordinal: number, occurrenceCount: number, lastOccurrence: boolean) => ({ ordinal, occurrenceCount, lastOccurrence })

  it('no mirrored rows → text-only removal', () => {
    expect(resolveBillRowMapping([], occ(0, 1, true))).toEqual({ outcome: 'none' })
  })
  it('one SHARED row for duplicates is kept until the last occurrence goes', () => {
    expect(resolveBillRowMapping([{ id: 'a', sortOrder: 0 }], occ(1, 2, false))).toEqual({ outcome: 'keep' })
    expect(resolveBillRowMapping([{ id: 'a', sortOrder: 0 }], occ(0, 1, true))).toEqual({ outcome: 'delete', id: 'a' })
  })
  it('one row per occurrence maps the removed ordinal through stable sort_order (input order irrelevant)', () => {
    const rows = [{ id: 'later', sortOrder: 2 }, { id: 'earlier', sortOrder: 0 }]
    expect(resolveBillRowMapping(rows, occ(1, 2, false))).toEqual({ outcome: 'delete', id: 'later' })
    expect(resolveBillRowMapping(rows, occ(0, 2, false))).toEqual({ outcome: 'delete', id: 'earlier' })
  })
  it('sort_order ties hide which row is which → ambiguous', () => {
    expect(resolveBillRowMapping([{ id: 'a', sortOrder: 0 }, { id: 'b', sortOrder: 0 }], occ(0, 2, false))).toEqual({ outcome: 'ambiguous' })
  })
  it('counts matching neither shape (e.g. one text name, two bill rows) → ambiguous', () => {
    expect(resolveBillRowMapping([{ id: 'a', sortOrder: 0 }, { id: 'b', sortOrder: 1 }], occ(0, 1, true))).toEqual({ outcome: 'ambiguous' })
    expect(resolveBillRowMapping([{ id: 'a', sortOrder: 0 }, { id: 'b', sortOrder: 1 }, { id: 'c', sortOrder: 2 }], occ(0, 2, false))).toEqual({ outcome: 'ambiguous' })
  })
})

describe('removeServiceFromJob — real persistence path (PGlite)', () => {
  it('fresh duplicates (one bill row each): removes only the selected occurrence and ITS attached charge', async () => {
    const orderId = await newRetailOrder(['Wash', 'Polish', 'Wash'])
    const estId = await mirrorEstimate(orderId)
    // Fresh promote of a duplicated list really does create one row per occurrence.
    const washRows = await billRows(estId, 'Wash')
    expect(washRows).toHaveLength(2)
    await addLine(washRows[0].id, { type: 'part', name: 'Clay bar', priceCents: 2000 })
    await addLine(washRows[1].id, { type: 'part', name: 'Trim tool', priceCents: 3500 })

    const r = await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })
    expect(r).toMatchObject({ removed: true, services: ['Wash', 'Polish'], pricingImpactCents: 3500 })

    // The second occurrence's row + charge are gone; the first keeps its own charge.
    expect(await estimateServiceTitles(estId)).toEqual(['Polish', 'Wash'])
    expect((await billRows(estId, 'Wash')).map((x) => x.id)).toEqual([washRows[0].id])
    expect(await linesOf(washRows[0].id)).toHaveLength(1)
    expect(await linesOf(washRows[1].id)).toHaveLength(0)

    // Removing the final occurrence now deletes the remaining row and its charge.
    const r2 = await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 0, expectedServices: ['Wash', 'Polish'] })
    expect(r2).toMatchObject({ removed: true, services: ['Polish'], pricingImpactCents: 2000 })
    expect(await estimateServiceTitles(estId)).toEqual(['Polish'])
    expect(await linesOf(washRows[0].id)).toHaveLength(0)
  })

  it('legacy SHARED mirror: the row and its charges stay until the last occurrence is removed', async () => {
    const orderId = await newRetailOrder(['Wash'])
    const estId = await mirrorEstimate(orderId)
    const [shared] = await billRows(estId, 'Wash')
    await addLine(shared.id, { type: 'part', name: 'Clay bar', priceCents: 2000 })
    // Legacy duplicate: the confirmed add appends the text, the re-promote skips the title.
    await db.update(serviceOrders).set({ services: ['Wash', 'Wash'] }).where(eq(serviceOrders.id, orderId))
    await promoteTextServices(estId, orderId)
    expect(await billRows(estId, 'Wash')).toHaveLength(1)

    const r = await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 1, expectedServices: ['Wash', 'Wash'] })
    expect(r).toMatchObject({ removed: true, services: ['Wash'], pricingImpactCents: null })
    expect(await billRows(estId, 'Wash')).toHaveLength(1)
    expect(await linesOf(shared.id)).toHaveLength(1)

    const r2 = await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 0, expectedServices: ['Wash'] })
    expect(r2).toMatchObject({ removed: true, services: [], pricingImpactCents: 2000 })
    expect(await billRows(estId, 'Wash')).toHaveLength(0)
    expect(await linesOf(shared.id)).toHaveLength(0)
  })

  it('reopens covered part labor exactly when its bill row is deleted — never while a duplicate keeps it', async () => {
    const orderId = await newRetailOrder(['Wash', 'Polish', 'Wash'])
    const estId = await mirrorEstimate(orderId)
    const washRows = await billRows(estId, 'Wash')
    // A part whose installation labor is covered by the FIRST Wash row.
    const [part] = await db.insert(jobParts).values({
      serviceOrderId: orderId, description: 'Wheel seal', laborServiceId: washRows[0].id, laborStatus: 'labor_added',
    }).returning()

    // Removing the SECOND occurrence deletes the second row — the part's labor link survives.
    await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })
    let [p] = await db.select().from(jobParts).where(eq(jobParts.id, part.id))
    expect(p.laborStatus).toBe('labor_added')
    expect(p.laborServiceId).toBe(washRows[0].id)

    // Removing the last occurrence deletes the covering row → the review reopens (part kept).
    await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 0, expectedServices: ['Wash', 'Polish'] })
    ;[p] = await db.select().from(jobParts).where(eq(jobParts.id, part.id))
    expect(p.laborStatus).toBe('needs_review')
    expect(p.laborServiceId).toBeNull()
    expect(p.status).not.toBe('cancelled')
    expect(await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.eventType, 'part_labor_reopened'))).toHaveLength(1)
  })

  it('ambiguous legacy mapping (one text occurrence, two bill rows) mutates NOTHING', async () => {
    const orderId = await newRetailOrder(['Wash'])
    const estId = await mirrorEstimate(orderId)
    const [promoted] = await billRows(estId, 'Wash')
    await addLine(promoted.id, { type: 'part', name: 'Clay bar', priceCents: 2000 })
    // A manually-added billing row with the same title — provenance unknowable.
    const [manual] = await db.insert(jobServices).values({ jobEstimateId: estId, title: 'Wash', source: 'manual' }).returning()
    await addLine(manual.id, { type: 'labor', name: 'Hand wash', priceCents: 4000 })

    const r = await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 0, expectedServices: ['Wash'] })
    expect(r).toMatchObject({ removed: false, ambiguous: true, services: ['Wash'] })
    expect((await orderRow(orderId)).services).toEqual(['Wash'])
    expect(await billRows(estId, 'Wash')).toHaveLength(2)
    expect(await linesOf(promoted.id)).toHaveLength(1)
    expect(await linesOf(manual.id)).toHaveLength(1)
    expect(await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.eventType, 'service_removed'))).toHaveLength(0)
  })

  it('sort_order ties between duplicate bill rows also fail closed before any write', async () => {
    const orderId = await newRetailOrder(['Wash', 'Wash'])
    const est = await getOrCreateEstimate(orderId, 'Test Manager')
    // Two same-titled rows with the default sort_order (0) — occurrence order unknowable.
    await db.insert(jobServices).values({ jobEstimateId: est.id, title: 'Wash', source: 'manual' })
    await db.insert(jobServices).values({ jobEstimateId: est.id, title: 'Wash', source: 'manual' })

    const r = await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 1, expectedServices: ['Wash', 'Wash'] })
    expect(r).toMatchObject({ removed: false, ambiguous: true })
    expect((await orderRow(orderId)).services).toEqual(['Wash', 'Wash'])
    expect(await billRows(est.id, 'Wash')).toHaveLength(2)
  })

  it('a stale snapshot (e.g. a retried request) changes NOTHING', async () => {
    const orderId = await newRetailOrder(['Wash', 'Polish'])
    const estId = await mirrorEstimate(orderId)

    const r = await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })
    expect(r).toMatchObject({ removed: false, stale: true, services: ['Wash', 'Polish'] })
    expect((await orderRow(orderId)).services).toEqual(['Wash', 'Polish'])
    expect(await estimateServiceTitles(estId)).toEqual(['Polish', 'Wash'])
    // Nothing removed → nothing audited as removed.
    expect(await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.eventType, 'service_removed'))).toHaveLength(0)
  })

  it('duplicates with no index remove nothing (legacy callers can no longer wipe both)', async () => {
    const orderId = await newRetailOrder(['Wash', 'Wash'])
    await mirrorEstimate(orderId)
    const r = await removeServiceFromJob(orderId, 'Wash', 'Test Manager')
    expect(r).toMatchObject({ removed: false, stale: true })
    expect((await orderRow(orderId)).services).toEqual(['Wash', 'Wash'])
  })

  it('an unknown service is a no-op (removed: false, not stale)', async () => {
    const orderId = await newRetailOrder(['Wash'])
    const r = await removeServiceFromJob(orderId, 'Wax', 'Test Manager', { index: 0, expectedServices: ['Wash'] })
    expect(r).toMatchObject({ removed: false })
    expect(r.stale).toBeUndefined()
    expect((await orderRow(orderId)).services).toEqual(['Wash'])
  })

  it('two simultaneous removals from the same snapshot: one wins, one goes stale, no lost update', async () => {
    const orderId = await newRetailOrder(['Wash', 'Polish'])
    const estId = await mirrorEstimate(orderId)
    const [washRow] = await billRows(estId, 'Wash')
    const [polishRow] = await billRows(estId, 'Polish')
    await addLine(washRow.id, { type: 'part', name: 'Clay bar', priceCents: 2000 })
    await addLine(polishRow.id, { type: 'labor', name: 'Polish labor', priceCents: 5000 })

    // Both managers acted on the same displayed list but picked DIFFERENT lines. Each
    // call awaits several reads before its compare-and-set write, so against PGlite's
    // single serialized connection both read the original snapshot before either
    // writes; even if one finished entirely first, the other's stored-vs-expected
    // snapshot check fails the same way. Either ordering must yield exactly one
    // removal — the loser must NOT overwrite the winner (which would resurrect the
    // removed service and lose the winner's edit).
    const [ra, rb] = await Promise.all([
      removeServiceFromJob(orderId, 'Wash', 'Manager A', { index: 0, expectedServices: ['Wash', 'Polish'] }),
      removeServiceFromJob(orderId, 'Polish', 'Manager B', { index: 1, expectedServices: ['Wash', 'Polish'] }),
    ])
    const results = [ra, rb]
    expect(results.filter((r) => r.removed)).toHaveLength(1)
    expect(results.filter((r) => r.stale)).toHaveLength(1)

    // The stored list is exactly the winner's result — one service survives, untouched.
    const survivor = ra.removed ? 'Polish' : 'Wash'
    const survivorRow = ra.removed ? polishRow : washRow
    const removedRow = ra.removed ? washRow : polishRow
    expect((await orderRow(orderId)).services).toEqual([survivor])
    expect((await billRows(estId)).map((r) => r.title)).toEqual([survivor])
    expect(await linesOf(survivorRow.id)).toHaveLength(1)
    expect(await linesOf(removedRow.id)).toHaveLength(0)

    // Exactly one removal happened, so exactly one is audited.
    expect(await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.eventType, 'service_removed'))).toHaveLength(1)
  })

  it('never touches another order with the same service name, nor the Job status / completedAt', async () => {
    const completedAt = new Date('2026-11-01T17:00:00Z')
    const orderA = await newRetailOrder(['Wash', 'Polish'], { status: 'ready', completedAt })
    const orderB = await newRetailOrder(['Wash'])
    const estB = await mirrorEstimate(orderB)
    await mirrorEstimate(orderA)

    const r = await removeServiceFromJob(orderA, 'Wash', 'Test Manager', { index: 0, expectedServices: ['Wash', 'Polish'] })
    expect(r).toMatchObject({ removed: true, services: ['Polish'], qbSyncNeeded: false })

    const a = await orderRow(orderA)
    expect(a.status).toBe('ready')                    // correction never un-completes a Job
    expect(a.completedAt).toEqual(completedAt)        // original production date untouched
    expect((await orderRow(orderB)).services).toEqual(['Wash'])
    expect(await estimateServiceTitles(estB)).toEqual(['Wash'])
  })

  it('audits the removal with the exact occurrence index', async () => {
    const orderId = await newRetailOrder(['Wash', 'Polish', 'Wash'])
    await mirrorEstimate(orderId)
    await removeServiceFromJob(orderId, 'Wash', 'Test Manager', { index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })
    const events = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.eventType, 'service_removed'))
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].note ?? '{}')).toMatchObject({ removed: 'Wash', index: 2, before: ['Wash', 'Polish', 'Wash'], after: ['Wash', 'Polish'] })
  })
})
