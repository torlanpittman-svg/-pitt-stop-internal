/**
 * Bulk installation-labor review ("Mark selected parts as covered" / "Part only") through the real
 * estimate route, on an engine-replacement job with 14 parts waiting on review.
 *
 *   - 13 of 14 → one part still needs review and the invoice still can't be created; the 14th →
 *     the invoice is eligible for creation at the EXACT same total.
 *   - It only records the decision: every price, quantity, line and total is byte-for-byte unchanged,
 *     and no labor line is added.
 *   - Previously reviewed parts are left alone; a retry / double-click writes nothing more.
 *   - A failure mid-write rolls back everything (never "some parts saved"), and the save feedback
 *     refuses to say "Saved" while a selected part is still open.
 *   - Several installation labor lines: nothing is preselected and the chosen line is the one linked.
 * PGlite + real schema + production-shaped catalog. No QuickBooks, no network.
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
// Lets one test hand the PRE-write coverage check a stale answer (the line still looks available), to
// prove the write statement applies the rule itself. Everything else uses the real function.
const stale = vi.hoisted(() => ({ passOnce: null as string | null }))
vi.mock('@/apps/workflow/estimate-review', async (orig) => {
  const real = await orig<typeof import('@/apps/workflow/estimate-review')>()
  return {
    ...real,
    coverableServiceIds: async (orderId: string) => {
      const ids = await real.coverableServiceIds(orderId)
      if (stale.passOnce) { ids.add(stale.passOnce); stale.passOnce = null }
      return ids
    },
  }
})
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => ({ name: 'Mgr', role: 'manager' }),
  employeeAuthorizedFromRequest: async () => true,
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { seedEngineJob, ENGINE_JOB_WORK_CENTS, ENGINE_JOB_LABOR_CENTS } from '@/apps/parts/engine-job-fixture.test-support'
import { getFullEstimate } from '@/apps/workflow/estimate-db'
import { getOrderWithContext } from '@/apps/workflow/db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { loadEstimateReview, assertEstimateReady } from '@/apps/workflow/estimate-review'
import { addEstimatePart, decidePartLabor, addPartForJobOnce } from '@/apps/parts/estimate-parts'
import { interpretSave, bulkLaborOutcome, type EstimateViewData } from '@/app/orders/[id]/estimate/save-feedback'
import { laborLineChoices, coverChoices, validCoverId } from '@/app/orders/[id]/estimate/PartsReview'
import { jobParts, jobServices, jobLineItems, jobEstimates, serviceOrderEvents } from '@/drizzle/schema'
import { POST } from './route'

let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  process.env.ESTIMATE_LAYER_ENABLED = 'true'
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  stale.passOnce = null
  await db.execute('DROP TRIGGER IF EXISTS fail_labor_audit ON service_order_events')
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
})

type Body = { ok: boolean; error?: string; savedPartIds?: string[]; view: EstimateViewData }
const call = async (orderId: string, body: unknown) => {
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: orderId }) })
  return { status: res.status, body: await res.json() as Body }
}
const cover = (partIds: string[], serviceId: string) => ({ action: 'part_labor_bulk', partIds, labor: { action: 'included', serviceId } })
const partOnly = (partIds: string[]) => ({ action: 'part_labor_bulk', partIds, labor: { action: 'part_only' } })
const openParts = (v: EstimateViewData) => (v.parts ?? []).filter((p) => p.laborStatus === 'needs_review')
const laborEvents = async (orderId: string) =>
  (await db.select().from(serviceOrderEvents).where(and(eq(serviceOrderEvents.serviceOrderId, orderId), eq(serviceOrderEvents.eventType, 'part_labor_review'))))
    .map((e) => JSON.parse(e.note ?? '{}') as { partId: string; part: string; status: string; laborServiceId: string | null; bulk?: boolean })

/** Everything that is money on the job: each service row, each line (qty, cost, price), each part's qty, and the estimate totals. */
async function moneySnapshot(orderId: string) {
  const [est] = await db.select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, orderId))
  const services = (await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, est.id)))
    .map((s) => ({ id: s.id, kind: s.kind, title: s.title, detail: s.detail, catalogId: s.catalogId })).sort((a, b) => a.id.localeCompare(b.id))
  const lines = (await db.select().from(jobLineItems)).filter((l) => services.some((s) => s.id === l.jobServiceId))
    .map((l) => ({ id: l.id, svc: l.jobServiceId, type: l.type, qty: l.qty, cost: l.costCents, price: l.priceCents, description: l.description })).sort((a, b) => a.id.localeCompare(b.id))
  const parts = (await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId)))
    .map((p) => ({ id: p.id, qty: p.quantity, cost: p.unitCostCents, sell: p.sellPriceCents, status: p.status, svc: p.jobServiceId })).sort((a, b) => a.id.localeCompare(b.id))
  return { priceMode: est.priceMode, explicitTotalCents: est.explicitTotalCents, totalCents: est.totalCents, qbSyncError: est.qbSyncError, services, lines, parts }
}
/** The Invoice Draft plus the same local gates Create Invoice applies before it talks to QuickBooks. */
async function invoiceState(orderId: string) {
  const [order, full, review] = await Promise.all([getOrderWithContext(orderId), getFullEstimate(orderId), loadEstimateReview(orderId)])
  const draft = buildInvoiceDraft({ order: order!, full, paymentLabel: 'Card charge', role: 'admin' })
  return { draft, eligible: draft.priced && !draft.pricingIncomplete && draft.referenceCents == null && review.readiness.ready, summary: review.readiness.summary }
}

describe('bulk labor review on the engine job (14 parts waiting)', () => {
  it('fixture: 14 parts need review; the one installation labor line is the only choice and is preselected — Mini Detail is not offered', async () => {
    const job = await seedEngineJob()
    const v = (await call(job.orderId, { action: 'prepare' })).body.view
    expect(openParts(v).map((p) => p.id).sort()).toEqual([...job.partIds].sort())
    expect(v.review?.issues).toEqual([expect.objectContaining({ code: 'part_labor', message: '14 parts need labor review' })])
    expect(v.workTotalCents).toBe(ENGINE_JOB_WORK_CENTS)
    const pick = laborLineChoices(v.services)
    expect(pick.preselectId).toBe(job.laborId)
    expect(pick.choices.map((s) => [s.title, s.detail, s.priceCents])).toEqual([['Installation Labor', 'Replacement engine', ENGINE_JOB_LABOR_CENTS]])
    expect(v.services.map((s) => s.title).sort()).toEqual(['EGR valve weld', 'Installation Labor', 'Mini Detail'])
  })

  it('13 of 14 → one still needs review and the invoice is not eligible; the 14th → eligible at the exact same total, nothing else changed', async () => {
    const job = await seedEngineJob()
    const before = await moneySnapshot(job.orderId)
    const start = await invoiceState(job.orderId)
    expect(start.eligible).toBe(false)
    expect(start.draft.totalCents).toBe(ENGINE_JOB_WORK_CENTS)
    const [engineBefore] = await db.select().from(jobParts).where(eq(jobParts.id, job.enginePartId))

    const exception = job.partIds[6]
    const thirteen = job.partIds.filter((id) => id !== exception)
    const edit1 = cover(thirteen, job.laborId)
    const r1 = await call(job.orderId, edit1)
    expect(r1.status).toBe(200)
    expect([...r1.body.savedPartIds!].sort()).toEqual([...thirteen].sort())
    expect(interpretSave(edit1, { ok: true, status: 200 }, r1.body)).toMatchObject({ ok: true })
    expect(openParts(r1.body.view).map((p) => p.id)).toEqual([exception])
    expect(r1.body.view.review?.issues).toEqual([expect.objectContaining({ code: 'part_labor', message: '1 part needs labor review', ids: [exception] })])
    const mid = await invoiceState(job.orderId)
    expect(mid.eligible).toBe(false)
    await expect(assertEstimateReady(job.orderId, 'invoice')).rejects.toThrow(/1 part needs labor review/)
    expect(await moneySnapshot(job.orderId)).toEqual(before)

    const edit2 = cover([exception], job.laborId)
    const r2 = await call(job.orderId, edit2)
    expect(r2.status).toBe(200)
    expect(r2.body.savedPartIds).toEqual([exception])
    expect(interpretSave(edit2, { ok: true, status: 200 }, r2.body)).toMatchObject({ ok: true })
    expect(r2.body.view.review).toEqual({ ready: true, issues: [] })
    expect(r2.body.view.parts!.filter((p) => job.partIds.includes(p.id)).every((p) => p.laborStatus === 'included' && p.laborServiceId === job.laborId)).toBe(true)
    await expect(assertEstimateReady(job.orderId, 'invoice')).resolves.toBeUndefined()
    const end = await invoiceState(job.orderId)
    expect(end.eligible).toBe(true)
    expect(end.draft.totalCents).toBe(start.draft.totalCents)
    expect(end.draft.workPriceCents).toBe(ENGINE_JOB_WORK_CENTS)
    expect(end.draft.serviceBreakdown).toEqual(start.draft.serviceBreakdown)
    expect(r2.body.view.workTotalCents).toBe(ENGINE_JOB_WORK_CENTS)
    expect(await moneySnapshot(job.orderId)).toEqual(before)   // every price, qty, line, total; no labor line added

    // Audit: one part_labor_review row per part, in the existing shape; the engine's own review untouched.
    const ev = (await laborEvents(job.orderId)).filter((e) => e.bulk)
    expect(ev).toHaveLength(14)
    expect(new Set(ev.map((e) => e.partId))).toEqual(new Set(job.partIds))
    expect(ev.every((e) => e.status === 'included' && e.laborServiceId === job.laborId && !!e.part)).toBe(true)
    const [engineAfter] = await db.select().from(jobParts).where(eq(jobParts.id, job.enginePartId))
    expect(engineAfter).toEqual(engineBefore)
  })

  it('retry, double-click and simultaneous requests write nothing more: one decision and one audit row per part, no labor line added', async () => {
    const job = await seedEngineJob()
    const before = await moneySnapshot(job.orderId)
    const edit = cover(job.partIds, job.laborId)
    const [a, b] = await Promise.all([call(job.orderId, edit), call(job.orderId, edit)])
    const c = await call(job.orderId, edit)
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect((a.body.savedPartIds!.length) + (b.body.savedPartIds!.length)).toBe(14)
    expect(c.body.savedPartIds).toEqual([])
    for (const r of [a, b, c]) expect(interpretSave(edit, { ok: true, status: 200 }, r.body)).toMatchObject({ ok: true })
    expect((await laborEvents(job.orderId)).filter((e) => e.bulk)).toHaveLength(14)
    expect(await moneySnapshot(job.orderId)).toEqual(before)
    expect(c.body.view.services.filter((s) => s.role === 'installation')).toHaveLength(1)
  })

  it('previously reviewed parts are left alone even when they are in the selection', async () => {
    const job = await seedEngineJob()
    const [waived, single, linked] = job.partIds
    await decidePartLabor(job.orderId, waived, { action: 'waive', reason: 'customer installs it' }, 'Mgr', 'manager')
    await decidePartLabor(job.orderId, single, { action: 'part_only' }, 'Mgr', 'manager')
    await decidePartLabor(job.orderId, linked, { action: 'included', serviceId: job.weldId }, 'Mgr', 'manager')
    const rowsBefore = await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, job.orderId))
    const keep = (id: string) => rowsBefore.find((p) => p.id === id)!

    const r = await call(job.orderId, cover([...job.partIds, job.enginePartId], job.laborId))
    expect(r.status).toBe(200)
    expect([...r.body.savedPartIds!].sort()).toEqual(job.partIds.slice(3).sort())
    for (const id of [waived, single, linked, job.enginePartId]) {
      const [now] = await db.select().from(jobParts).where(eq(jobParts.id, id))
      expect(now).toEqual(keep(id))
    }
    expect((await laborEvents(job.orderId)).filter((e) => e.bulk)).toHaveLength(11)
    expect(r.body.view.review?.ready).toBe(true)
  })

  it('"Part only" in bulk for a parts-only sale: decision recorded, same total, invoice eligible', async () => {
    const job = await seedEngineJob()
    const before = await moneySnapshot(job.orderId)
    const edit = partOnly(job.partIds)
    const r = await call(job.orderId, edit)
    expect(r.status).toBe(200)
    expect(interpretSave(edit, { ok: true, status: 200 }, r.body)).toMatchObject({ ok: true })
    expect(r.body.view.parts!.filter((p) => job.partIds.includes(p.id)).every((p) => p.laborStatus === 'part_only' && p.laborServiceId === null)).toBe(true)
    expect(await moneySnapshot(job.orderId)).toEqual(before)
    const end = await invoiceState(job.orderId)
    expect(end.eligible).toBe(true)
    expect(end.draft.totalCents).toBe(ENGINE_JOB_WORK_CENTS)
  })

  it('a failure part-way through the write saves NOTHING, and the retry then saves all of it once', async () => {
    const job = await seedEngineJob()
    // The 5th audit row of the statement fails → the whole statement (all 14 part updates) rolls back.
    await db.execute(`CREATE SEQUENCE IF NOT EXISTS fail_labor_audit_n`)
    await db.execute(`SELECT setval('fail_labor_audit_n', 1, false)`)
    await db.execute(`CREATE OR REPLACE FUNCTION fail_labor_audit_fn() RETURNS trigger AS $$ BEGIN
      IF NEW.event_type = 'part_labor_review' AND nextval('fail_labor_audit_n') = 5 THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`)
    await db.execute(`CREATE TRIGGER fail_labor_audit BEFORE INSERT ON service_order_events FOR EACH ROW EXECUTE FUNCTION fail_labor_audit_fn()`)
    const edit = cover(job.partIds, job.laborId)
    const failed = await call(job.orderId, edit)
    expect(failed.status).toBe(500)
    expect(interpretSave(edit, { ok: false, status: 500 }, failed.body)).toMatchObject({ ok: false })
    expect((await laborEvents(job.orderId)).filter((e) => e.bulk)).toHaveLength(0)
    const v = (await call(job.orderId, { action: 'prepare' })).body.view
    expect(openParts(v)).toHaveLength(14)            // the screen (server state) still shows all 14 open

    await db.execute('DROP TRIGGER fail_labor_audit ON service_order_events')
    const retry = await call(job.orderId, edit)
    expect(retry.status).toBe(200)
    expect(retry.body.savedPartIds).toHaveLength(14)
    expect((await laborEvents(job.orderId)).filter((e) => e.bulk)).toHaveLength(14)
    expect(retry.body.view.review?.ready).toBe(true)
  })

  it('"Saved" is refused while any selected part is still open in the server’s view', async () => {
    const job = await seedEngineJob()
    const stale = (await call(job.orderId, { action: 'prepare' })).body       // a reply that changed nothing
    const out = interpretSave(cover(job.partIds.slice(0, 3), job.laborId), { ok: true, status: 200 }, { ok: true, view: stale.view })
    // …and the reply's view is handed back, so the page shows the server's state rather than a stale list.
    expect(out).toEqual({ ok: false, error: '3 of the selected parts still need labor review. Try again.', view: stale.view })
  })

  it('a covering line must be a real work line on THIS job; bad requests write nothing', async () => {
    const job = await seedEngineJob()
    const other = await seedEngineJob()
    const [enginePart] = await db.select().from(jobParts).where(eq(jobParts.id, job.enginePartId))
    for (const serviceId of [other.laborId, enginePart.jobServiceId!, '00000000-0000-4000-8000-000000000000', '']) {
      const r = await call(job.orderId, cover(job.partIds, serviceId))
      expect(r.status).toBe(500)
      expect(r.body.error).toMatch(serviceId ? /no longer available on this invoice/ : /Choose a labor line on this invoice/)
    }
    expect((await call(job.orderId, cover([], job.laborId))).body.error).toMatch(/Select at least one part/)
    // Parts of a different job in the selection are ignored, never written.
    const r = await call(job.orderId, cover(other.partIds, job.laborId))
    expect(r.body.savedPartIds).toEqual([])
    expect((await laborEvents(job.orderId)).filter((e) => e.bulk)).toHaveLength(0)
    expect((await laborEvents(other.orderId)).filter((e) => e.bulk)).toHaveLength(0)
    expect(openParts((await call(other.orderId, { action: 'prepare' })).body.view)).toHaveLength(14)
  })

  it('a part whose covering labor was removed is open again and is picked up by the bulk action', async () => {
    const job = await seedEngineJob()
    await call(job.orderId, cover(job.partIds.slice(0, 2), job.weldId))
    await call(job.orderId, { action: 'remove_service', serviceId: job.weldId })
    const v = (await call(job.orderId, { action: 'prepare' })).body.view
    expect(openParts(v)).toHaveLength(14)
    const r = await call(job.orderId, cover(job.partIds, job.laborId))
    expect(r.body.savedPartIds).toHaveLength(14)
    expect(r.body.view.review?.ready).toBe(true)
  })
})

describe('bulk save feedback reports only what the server confirmed', () => {
  /** What the page would show for this request + this server reply. */
  const shown = (edit: ReturnType<typeof cover> | ReturnType<typeof partOnly>, r: { status: number; body: Body }) => interpretSave(edit, { ok: r.status === 200, status: r.status }, r.body)
  const bulkRows = async (orderId: string) => (await laborEvents(orderId)).filter((e) => e.bulk)

  it('two selected, one removed before the save: "1 part", never "2 parts"', async () => {
    const job = await seedEngineJob()
    const [kept, gone] = job.partIds
    await call(job.orderId, { action: 'remove_part', partId: gone, labor: { action: 'keep' } })     // cancelled on another screen
    const edit = cover([kept, gone], job.laborId)
    const r = await call(job.orderId, edit)
    expect(r.body.savedPartIds).toEqual([kept])
    expect(bulkLaborOutcome(edit, r.body.view)).toEqual({ selected: 2, confirmed: 1, unchanged: 0, missing: 1, open: 0 })
    expect(shown(edit, r)).toMatchObject({ ok: true, message: '1 part marked as covered · 1 part no longer on the invoice · Saved' })
    expect(await bulkRows(job.orderId)).toHaveLength(1)
    const [cancelled] = await db.select().from(jobParts).where(eq(jobParts.id, gone))
    expect(cancelled).toMatchObject({ status: 'cancelled', laborStatus: 'needs_review', laborServiceId: null })   // never written
  })

  it('a selected part another manager reviewed differently is reported as left unchanged, not as covered', async () => {
    const job = await seedEngineJob()
    const [mine, waived, otherLine] = job.partIds
    await decidePartLabor(job.orderId, waived, { action: 'waive', reason: 'customer installs it' }, 'Other Mgr', 'manager')
    await decidePartLabor(job.orderId, otherLine, { action: 'included', serviceId: job.weldId }, 'Other Mgr', 'manager')
    const before = await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, job.orderId))
    const edit = cover([mine, waived, otherLine], job.laborId)
    const r = await call(job.orderId, edit)
    expect(bulkLaborOutcome(edit, r.body.view)).toEqual({ selected: 3, confirmed: 1, unchanged: 2, missing: 0, open: 0 })
    expect(shown(edit, r)).toMatchObject({ ok: true, message: '1 part marked as covered · 2 parts already reviewed — left unchanged · Saved' })
    for (const id of [waived, otherLine]) expect((await db.select().from(jobParts).where(eq(jobParts.id, id)))[0]).toEqual(before.find((p) => p.id === id))
    expect(await bulkRows(job.orderId)).toHaveLength(1)
  })

  it('identical retry after a save whose response was lost: confirmed again, no new audit row, no false failure', async () => {
    const job = await seedEngineJob()
    const edit = cover(job.partIds, job.laborId)
    await call(job.orderId, edit)                                  // saved; the reply never reached the page
    const rowsAfterFirst = await bulkRows(job.orderId)
    const partsAfterFirst = await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, job.orderId))
    const retry = await call(job.orderId, edit)
    expect(retry.status).toBe(200)
    expect(retry.body.savedPartIds).toEqual([])                    // this request wrote nothing…
    expect(shown(edit, retry)).toMatchObject({ ok: true, message: '14 parts marked as covered · Saved' })   // …and the persisted outcome is confirmed
    expect(await bulkRows(job.orderId)).toEqual(rowsAfterFirst)
    expect((await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, job.orderId))).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(partsAfterFirst.sort((a, b) => a.id.localeCompare(b.id)))                                    // not even a timestamp moved
  })

  it('bulk "Part only" is counted the same way — and a "covered" request never claims parts that are part only', async () => {
    const job = await seedEngineJob()
    const [a, b, gone, linked] = job.partIds
    await call(job.orderId, { action: 'remove_part', partId: gone, labor: { action: 'keep' } })
    await decidePartLabor(job.orderId, linked, { action: 'included', serviceId: job.laborId }, 'Other Mgr', 'manager')
    const edit = partOnly([a, b, gone, linked])
    const r = await call(job.orderId, edit)
    expect(bulkLaborOutcome(edit, r.body.view)).toEqual({ selected: 4, confirmed: 2, unchanged: 1, missing: 1, open: 0 })
    expect(shown(edit, r)).toMatchObject({ ok: true, message: '2 parts marked part only · 1 part already reviewed — left unchanged · 1 part no longer on the invoice · Saved' })
    const retry = await call(job.orderId, edit)
    expect(retry.body.savedPartIds).toEqual([])
    expect(shown(edit, retry)).toMatchObject({ ok: true, message: '2 parts marked part only · 1 part already reviewed — left unchanged · 1 part no longer on the invoice · Saved' })
    expect(await bulkRows(job.orderId)).toHaveLength(2)
    // The same parts sent as "covered" afterwards: nothing is covered, and the page says so.
    const wrong = cover([a, b], job.laborId)
    const w = await call(job.orderId, wrong)
    expect(shown(wrong, w)).toMatchObject({ ok: true, message: 'No parts changed · 2 parts already reviewed — left unchanged' })
    expect(await bulkRows(job.orderId)).toHaveLength(2)
  })

  it('duplicate ids in a request are one part; a part covered by a DIFFERENT line is not counted as covered by the chosen one', async () => {
    const job = await seedEngineJob()
    const [a] = job.partIds
    const first = cover([a, a], job.weldId)
    expect(shown(first, await call(job.orderId, first))).toMatchObject({ ok: true, message: '1 part marked as covered · Saved' })
    const other = cover([a], job.laborId)
    const r = await call(job.orderId, other)
    expect(shown(other, r)).toMatchObject({ ok: true, message: 'No parts changed · 1 part already reviewed — left unchanged' })
    expect(r.body.view.parts!.find((p) => p.id === a)?.laborServiceId).toBe(job.weldId)
  })
})

describe('the one-part "Already included" picker', () => {
  it('never offers a declined line, treats a stale pick as no pick, and the server refuses a stale declined selection', async () => {
    const job = await seedEngineJob()
    const opened = (await call(job.orderId, { action: 'prepare' })).body.view
    expect(coverChoices(opened.services).map((s) => s.title).sort()).toEqual(['EGR valve weld', 'Installation Labor', 'Mini Detail'])
    expect(validCoverId(opened.services, job.weldId)).toBe(job.weldId)

    await call(job.orderId, { action: 'set_approval', serviceId: job.weldId, state: 'declined' })
    const now = (await call(job.orderId, { action: 'prepare' })).body.view
    expect(now.services.find((s) => s.id === job.weldId)?.declined).toBe(true)                 // still on the invoice…
    expect(coverChoices(now.services).map((s) => s.title).sort()).toEqual(['Installation Labor', 'Mini Detail'])   // …but not offered
    expect(validCoverId(now.services, job.weldId)).toBe('')                                    // a pick made before the decline is void
    expect(validCoverId(now.services, 'not-a-line')).toBe('')

    // A page that never refreshed still posts the declined line: refused, nothing written.
    const partsBefore = await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, job.orderId))
    const auditBefore = await laborEvents(job.orderId)
    const edit = { action: 'part_labor', partId: job.partIds[0], labor: { action: 'included', serviceId: job.weldId } }
    const r = await call(job.orderId, edit)
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/Choose a labor line on this estimate that covers installing this part/)
    expect(interpretSave(edit, { ok: false, status: 500 }, r.body)).toMatchObject({ ok: false })
    expect((await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, job.orderId))).sort((a, b) => a.id.localeCompare(b.id))).toEqual(partsBefore.sort((a, b) => a.id.localeCompare(b.id)))
    expect(await laborEvents(job.orderId)).toEqual(auditBefore)
  })
})

describe('a declined labor line covers nothing', () => {
  const decline = (orderId: string, serviceId: string, state = 'declined') => call(orderId, { action: 'set_approval', serviceId, state })
  const partRows = async (orderId: string) => (await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId))).sort((a, b) => a.id.localeCompare(b.id))

  it('stale selection: the line is declined after Review was opened → explained, parts stay open, no audit rows, nothing changed', async () => {
    const job = await seedEngineJob()
    // The manager opens Review: the one installation line is offered and preselected.
    const opened = (await call(job.orderId, { action: 'prepare' })).body.view
    const chosen = laborLineChoices(opened.services).preselectId
    expect(chosen).toBe(job.laborId)
    const selection = openParts(opened).map((p) => p.id)
    expect(selection).toHaveLength(14)

    // Someone else declines that line.
    expect((await decline(job.orderId, job.laborId)).status).toBe(200)
    const partsBefore = await partRows(job.orderId)
    const money = await moneySnapshot(job.orderId)
    const auditBefore = await laborEvents(job.orderId)

    // The manager submits the stale selection.
    const edit = cover(selection, chosen)
    const r = await call(job.orderId, edit)
    expect(r.status).toBe(500)
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toBe('That labor line is no longer available on this invoice (it was removed or declined). This request changed nothing — choose another line.')
    expect(interpretSave(edit, { ok: false, status: 500 }, r.body)).toEqual({ ok: false, error: r.body.error })
    expect(await partRows(job.orderId)).toEqual(partsBefore)                 // not one part row touched
    expect(await laborEvents(job.orderId)).toEqual(auditBefore)              // no review audit rows written
    expect(await moneySnapshot(job.orderId)).toEqual(money)

    // The current screen state: all 14 still open (plus the engine, whose own labor was the declined line),
    // and the declined line is no longer offered or preselected.
    const now = (await call(job.orderId, { action: 'prepare' })).body.view
    expect(selection.every((id) => openParts(now).some((p) => p.id === id))).toBe(true)
    const pick = laborLineChoices(now.services)
    expect(pick.preselectId).toBe('')
    expect(pick.choices.some((s) => s.id === job.laborId)).toBe(false)
    await expect(assertEstimateReady(job.orderId, 'invoice')).rejects.toThrow(/15 parts need labor review/)

    // The one-part "Already included" path applies the same rule.
    const single = await call(job.orderId, { action: 'part_labor', partId: selection[0], labor: { action: 'included', serviceId: job.laborId } })
    expect(single.status).toBe(500)
    expect(single.body.error).toMatch(/Choose a labor line on this estimate that covers installing this part/)
    expect(await partRows(job.orderId)).toEqual(partsBefore)
    expect(await laborEvents(job.orderId)).toEqual(auditBefore)
  })

  it('a part already linked to a line that is later declined is open again everywhere — and holds again if the line is re-approved', async () => {
    const job = await seedEngineJob()
    const thirteen = job.partIds.slice(0, 13)
    await call(job.orderId, cover(thirteen, job.laborId))
    expect(openParts((await call(job.orderId, { action: 'prepare' })).body.view)).toHaveLength(1)
    const linkedRows = await partRows(job.orderId)

    await decline(job.orderId, job.laborId)
    const v = (await call(job.orderId, { action: 'prepare' })).body.view
    // Screen, review gate and invoice gate agree: 13 linked + the engine + the 1 never reviewed = 15 open.
    expect(openParts(v)).toHaveLength(15)
    expect(v.review?.issues).toEqual([expect.objectContaining({ code: 'part_labor', message: '15 parts need labor review' })])
    expect((await loadEstimateReview(job.orderId)).readiness.ready).toBe(false)
    expect((await invoiceState(job.orderId)).eligible).toBe(false)
    expect(await partRows(job.orderId)).toEqual(linkedRows)       // derived, not rewritten: the saved link is kept

    // The bulk action treats them as open too: they can be covered by a line that is still live.
    const r = await call(job.orderId, cover(job.partIds, job.weldId))
    expect([...r.body.savedPartIds!].sort()).toEqual([...job.partIds].sort())
    expect(openParts(r.body.view).map((p) => p.id)).toEqual([job.enginePartId])

    // Re-approving the installation line restores the engine's own link (nothing was rewritten for it).
    await decline(job.orderId, job.laborId, 'approved')
    const back = (await call(job.orderId, { action: 'prepare' })).body.view
    expect(openParts(back)).toHaveLength(0)
    expect(back.parts!.find((p) => p.id === job.enginePartId)).toMatchObject({ laborStatus: 'labor_added', laborServiceId: job.laborId })
  })

  it('the line is declined between the check and the write: the statement itself writes nothing and the reply says why', async () => {
    const job = await seedEngineJob()
    await decline(job.orderId, job.laborId)
    const partsBefore = await partRows(job.orderId)
    // Simulate the race: the pre-write check still sees the line as available (it read just before the
    // decline landed). Only the rule evaluated inside the write statement can stop the save now.
    stale.passOnce = job.laborId
    const r = await call(job.orderId, cover(job.partIds, job.laborId))
    expect(stale.passOnce).toBeNull()                                   // the stale pre-check really was used
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/no longer available on this invoice/)
    expect(await partRows(job.orderId)).toEqual(partsBefore)
    expect((await laborEvents(job.orderId)).filter((e) => e.bulk)).toHaveLength(0)
  })
})

describe('every other way of linking a part to a line applies the same rule', () => {
  const liveParts = async (orderId: string) => (await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId))).filter((p) => p.status !== 'cancelled')

  it('"clarify — it’s the labor, add the part" on a declined line is refused and writes nothing', async () => {
    const job = await seedEngineJob()
    await call(job.orderId, { action: 'set_approval', serviceId: job.weldId, state: 'declined' })
    const before = { parts: (await liveParts(job.orderId)).length, audit: await laborEvents(job.orderId), money: await moneySnapshot(job.orderId) }
    const r = await call(job.orderId, { action: 'clarify_part', serviceId: job.weldId, part: { description: 'EGR valve', supply: 'shop', quantity: 1, sellPriceCents: 5000 } })
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/was declined, so it can’t cover installing a part/)
    expect((await liveParts(job.orderId)).length).toBe(before.parts)
    expect(await laborEvents(job.orderId)).toEqual(before.audit)
    expect(await moneySnapshot(job.orderId)).toEqual(before.money)
  })

  it('adding a part attached to a declined service — by id or by its title — never records it as covered', async () => {
    const job = await seedEngineJob()
    await call(job.orderId, { action: 'set_approval', serviceId: job.weldId, state: 'declined' })
    const before = { parts: (await liveParts(job.orderId)).length, audit: await laborEvents(job.orderId) }
    const part = { description: 'Weld rod', supply: 'shop' as const, quantity: 1, sellPriceCents: 500 }
    for (const target of [job.weldId, { title: 'EGR valve weld' }] as Parameters<typeof addPartForJobOnce>[4][]) {
      await expect(addPartForJobOnce(job.orderId, part, 'Mgr', 'manager', target)).rejects.toThrow(/no longer on this job/)
    }
    expect((await liveParts(job.orderId)).length).toBe(before.parts)
    expect(await laborEvents(job.orderId)).toEqual(before.audit)
    // …while a live line still works exactly as before.
    const ok = await addPartForJobOnce(job.orderId, part, 'Mgr', 'manager', job.laborId)
    const saved = (await liveParts(job.orderId)).find((p) => p.description === 'Weld rod')
    expect(ok).toBeTruthy()
    expect(saved).toMatchObject({ laborStatus: 'included', laborServiceId: job.laborId })
  })

  it('part ids are matched case-insensitively end to end (a hand-built request cannot make the feedback wrong)', async () => {
    const job = await seedEngineJob()
    const edit = cover(job.partIds.slice(0, 2).map((id) => id.toUpperCase()), job.laborId)
    const r = await call(job.orderId, edit)
    expect(r.body.savedPartIds).toHaveLength(2)
    expect(interpretSave(edit, { ok: true, status: 200 }, r.body)).toMatchObject({ ok: true, message: '2 parts marked as covered · Saved' })
  })
})

describe('bulk labor review with several installation labor lines', () => {
  it('nothing is preselected; each line shows its component and price; the chosen line is the one linked', async () => {
    const job = await seedEngineJob()
    // A second installation job on the same invoice: a water pump with its own installation labor ($180).
    const pump = await addEstimatePart(job.orderId, { description: 'Water pump', supply: 'shop', quantity: 1, sellPriceCents: 9500 }, 'Mgr')
    await decidePartLabor(job.orderId, pump.id, { action: 'add_labor', cents: 18000 }, 'Mgr', 'manager')
    const [pumpRow] = await db.select().from(jobParts).where(eq(jobParts.id, pump.id))
    const pumpLaborId = pumpRow.laborServiceId!
    const gasket = await addEstimatePart(job.orderId, { description: 'Water pump gasket', supply: 'shop', quantity: 1, sellPriceCents: 1200 }, 'Mgr')
    const before = await moneySnapshot(job.orderId)
    const start = await invoiceState(job.orderId)

    const v = (await call(job.orderId, { action: 'prepare' })).body.view
    const pick = laborLineChoices(v.services)
    expect(pick.preselectId).toBe('')
    expect(pick.installOnly).toBe(true)
    expect(pick.choices.map((s) => [s.id, s.title, s.detail, s.priceCents])).toEqual([
      [job.laborId, 'Installation Labor', 'Replacement engine', 211000],
      [pumpLaborId, 'Installation Labor', 'Water pump', 18000],
    ])
    expect(pick.choices.some((s) => s.title === 'Mini Detail' || s.title === 'EGR valve weld')).toBe(false)

    const r1 = await call(job.orderId, cover(job.partIds, job.laborId))
    expect(openParts(r1.body.view).map((p) => p.id)).toEqual([gasket.id])
    expect((await invoiceState(job.orderId)).eligible).toBe(false)
    const r2 = await call(job.orderId, cover([gasket.id], pumpLaborId))
    expect(r2.body.view.review?.ready).toBe(true)
    const linked = Object.fromEntries(r2.body.view.parts!.map((p) => [p.id, p.laborServiceId]))
    expect(job.partIds.every((id) => linked[id] === job.laborId)).toBe(true)
    expect(linked[gasket.id]).toBe(pumpLaborId)
    expect(linked[pump.id]).toBe(pumpLaborId)

    const end = await invoiceState(job.orderId)
    expect(end.eligible).toBe(true)
    expect(end.draft.totalCents).toBe(start.draft.totalCents)
    expect(await moneySnapshot(job.orderId)).toEqual(before)
  })

  it('no installation line at all: any work line can be chosen but none is preselected; a declined line is never offered', async () => {
    const pick = laborLineChoices([
      { id: 'a', title: 'Mini Detail', priceCents: 20000, suggestedCents: null, role: null },
      { id: 'b', title: 'Engine swap labor', priceCents: 211000, suggestedCents: null, role: null },
      { id: 'c', title: 'Installation Labor', priceCents: 5000, suggestedCents: null, role: 'installation', declined: true },
    ])
    expect(pick).toMatchObject({ preselectId: '', installOnly: false })
    expect(pick.choices.map((s) => s.id)).toEqual(['a', 'b'])
  })
})
