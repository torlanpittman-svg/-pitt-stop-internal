/**
 * Regression tests for the estimate price-corruption bug: explicitly-entered per-service prices
 * must survive editing, mode switches, navigation/reopen, and the Work Total field — and no
 * operation may silently redistribute money across services (the "several lines → $0 and one
 * service → the whole total" corruption).
 *
 * These drive the REAL estimate-db functions against an in-memory PGlite Postgres (the schema is
 * pushed from the actual Drizzle schema), so they exercise the true persistence path — not a
 * re-implementation. Individual amounts are asserted, not just totals.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

// Imported after the mock is registered (vi.mock is hoisted).
import {
  getOrCreateEstimate, promoteTextServices, setExplicitPrice, recomputeEstimate,
  itemizeEstimate, setServicePrice, setWorkTotal, getEstimateView, prepareEstimateView,
  getFullEstimate, acceptItemizedTotal, getEstimateRow,
} from '@/apps/workflow/estimate-db'
import { getOrderWithContext } from '@/apps/workflow/db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { retailProductionValueCents } from '@/apps/workflow/production'
import { serviceOrders, vehicles, serviceCatalog } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let orderSeq = 0

async function seedCatalog(name: string, priceCents: number) {
  await db.insert(serviceCatalog).values({
    slug: name.toLowerCase().replace(/\s+/g, '-'), name, kind: 'package', defaultPriceCents: priceCents,
  }).onConflictDoNothing()
}

async function newRetailOrder(services: string[]): Promise<string> {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'Transit', year: '2021' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: `SO-TEST-${++orderSeq}`, vehicleId: v.id,
    source: 'quick_entry', serviceType: 'retail', status: 'arrived', services,
  }).returning()
  return o.id
}

/** Convenience: title → priceCents map for the current view. */
function prices(view: Awaited<ReturnType<typeof getEstimateView>>): Record<string, number | null> {
  return Object.fromEntries(view.services.map((s) => [s.title, s.priceCents]))
}
function serviceId(view: Awaited<ReturnType<typeof getEstimateView>>, title: string): string {
  return view.services.find((s) => s.title === title)!.id
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
  for (const t of ['job_line_items', 'job_services', 'job_estimates', 'service_order_events', 'service_orders', 'vehicles', 'service_catalog', 'service_price_tiers', 'service_aliases']) {
    await db.execute(`DELETE FROM ${t}`)
  }
})

describe('estimate pricing — explicitly saved prices survive; no silent redistribution', () => {
  it('multi-service itemized: distinct prices persist through reopen (individual amounts, not just total)', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await recomputeEstimate(est.id)

    let view = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view, 'Wash'), 10000, 'Torlan')
    view = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view, 'Interior Detail'), 30000, 'Torlan')
    view = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view, 'Polish'), 20000, 'Torlan')

    view = await getEstimateView(orderId)
    expect(prices(view)).toEqual({ 'Wash': 10000, 'Interior Detail': 30000, 'Polish': 20000 })
    expect(view.workTotalCents).toBe(60000)

    // Navigate away + reopen (prepareEstimateView runs on every open).
    const reopened = await prepareEstimateView(orderId, 'Torlan')
    expect(prices(reopened)).toEqual({ 'Wash': 10000, 'Interior Detail': 30000, 'Polish': 20000 })
    expect(reopened.workTotalCents).toBe(60000)
  })

  it('flat → itemize does NOT fabricate a catalog-weighted split (no $0 lines, no lump)', async () => {
    // Catalog recognizes ONLY "Wash" — the pre-fix code would have lumped the whole flat total
    // onto Wash and zeroed the rest.
    await seedCatalog('Wash', 10000)
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await setExplicitPrice(est.id, 60000, 'Torlan')   // born flat at $600 (intake work price)
    await recomputeEstimate(est.id)
    expect((await getEstimateView(orderId)).flat).toBe(true)

    await itemizeEstimate(est.id, 'Torlan')
    const view = await getEstimateView(orderId)

    // No service absorbs the whole total; nothing is redistributed. Services are left unpriced
    // for the manager to enter (catalog suggestions still surface as hints in the view).
    expect(view.flat).toBe(false)
    for (const s of view.services) expect(s.priceCents ?? 0).toBeLessThan(60000)
    expect(prices(view)).toEqual({ 'Wash': null, 'Interior Detail': null, 'Polish': null })
    expect(view.services.find((s) => s.title === 'Wash')!.suggestedCents).toBe(10000) // hint preserved

    // The agreed flat amount is RETAINED as a labeled reference and pricing is flagged incomplete —
    // it is NOT silently replaced by the $0 partial sum.
    expect(view.incomplete).toBe(true)
    expect(view.referenceCents).toBe(60000)
  })

  it('reference is retained while incomplete and DROPPED once every service is priced', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await setExplicitPrice(est.id, 60000, 'Torlan')   // born flat at $600
    await recomputeEstimate(est.id)

    // Price two of three → still incomplete, reference retained.
    let view = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view, 'Wash'), 10000, 'Torlan'); view = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view, 'Interior Detail'), 30000, 'Torlan'); view = await getEstimateView(orderId)
    expect(view.incomplete).toBe(true)
    expect(view.referenceCents).toBe(60000)
    expect(prices(view)).toEqual({ 'Wash': 10000, 'Interior Detail': 30000, 'Polish': null })

    // Price the last one → complete: reference dropped, incomplete false, amounts intact.
    await setServicePrice(est.id, serviceId(view, 'Polish'), 20000, 'Torlan')
    view = await getEstimateView(orderId)
    expect(view.incomplete).toBe(false)
    expect(view.referenceCents).toBeNull()
    expect(prices(view)).toEqual({ 'Wash': 10000, 'Interior Detail': 30000, 'Polish': 20000 })
    expect(view.workTotalCents).toBe(60000)
  })

  it('editing one price on a flat Job itemizes only that service (others not lumped/zeroed)', async () => {
    await seedCatalog('Wash', 10000)
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await setExplicitPrice(est.id, 60000, 'Torlan')
    await recomputeEstimate(est.id)

    const view0 = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view0, 'Interior Detail'), 30000, 'Torlan')

    const view = await getEstimateView(orderId)
    // Exactly the edited service is priced; the flat $600 was NOT split across the others.
    expect(prices(view)).toEqual({ 'Wash': null, 'Interior Detail': 30000, 'Polish': null })
    expect(view.workTotalCents).toBe(30000)
  })

  it('setWorkTotal on a priced itemized Job does NOT redistribute across services', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    let view = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view, 'Wash'), 10000, 'Torlan'); view = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view, 'Interior Detail'), 30000, 'Torlan'); view = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view, 'Polish'), 20000, 'Torlan')

    // Attempt to override the Work Total to a very different number.
    await setWorkTotal(est.id, 99900, 'Torlan')
    view = await getEstimateView(orderId)
    // Individual prices are untouched (the itemized total is derived, not authoritative).
    expect(prices(view)).toEqual({ 'Wash': 10000, 'Interior Detail': 30000, 'Polish': 20000 })
    expect(view.workTotalCents).toBe(60000)
  })

  it('setWorkTotal with only SOME services priced does not lump the total onto them', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    const view0 = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(view0, 'Wash'), 10000, 'Torlan')   // only Wash priced

    await setWorkTotal(est.id, 60000, 'Torlan')
    const view = await getEstimateView(orderId)
    // Pre-fix this jumped Wash to $600; now it stays exactly what the manager typed.
    expect(view.services.find((s) => s.title === 'Wash')!.priceCents).toBe(10000)
  })

  it('setWorkTotal on a fresh Job with no per-service prices still sets a flat price', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)

    await setWorkTotal(est.id, 45000, 'Torlan')
    const view = await getEstimateView(orderId)
    expect(view.flat).toBe(true)
    expect(view.workTotalCents).toBe(45000)
  })
})

describe('invoice draft never presents a silent $0/partial in place of an agreed amount', () => {
  async function draftFor(orderId: string) {
    const order = await getOrderWithContext(orderId)
    const full = await getFullEstimate(orderId)
    return buildInvoiceDraft({ order: order!, full, paymentLabel: 'Card', role: 'admin' })
  }

  it('incomplete itemization → draft flags pricingIncomplete + agreed reference; clears when complete', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await setExplicitPrice(est.id, 60000, 'Torlan')
    await recomputeEstimate(est.id)
    await itemizeEstimate(est.id, 'Torlan')
    let v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Wash'), 10000, 'Torlan')   // 1 of 3 priced

    const d = await draftFor(orderId)
    expect(d.pricingIncomplete).toBe(true)
    expect(d.referenceCents).toBe(60000)

    // Finish pricing → incomplete clears, reference gone, breakdown is the real per-service split.
    v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Interior Detail'), 30000, 'Torlan'); v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Polish'), 20000, 'Torlan')
    const d2 = await draftFor(orderId)
    expect(d2.pricingIncomplete).toBe(false)
    expect(d2.referenceCents).toBeNull()
    expect(d2.serviceBreakdown).toEqual([
      { title: 'Wash', cents: 10000 }, { title: 'Interior Detail', cents: 30000 }, { title: 'Polish', cents: 20000 },
    ])
  })

  it('a fully flat Job is authoritative — never flagged incomplete', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await setExplicitPrice(est.id, 50000, 'Torlan')
    await recomputeEstimate(est.id)
    const d = await draftFor(orderId)
    expect(d.pricingIncomplete).toBe(false)
    expect(d.referenceCents).toBeNull()
    expect(d.workPriceCents).toBe(50000)
  })
})

describe('rapid edits, navigation/reopen, and a rejected Work Total all show the persisted result', () => {
  it('rapid successive price edits all persist (no lost update, no redistribution)', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    const v = await getEstimateView(orderId)
    const ids = { wash: serviceId(v, 'Wash'), interior: serviceId(v, 'Interior Detail'), polish: serviceId(v, 'Polish') }
    await setServicePrice(est.id, ids.wash, 10000, 'Torlan')
    await setServicePrice(est.id, ids.interior, 30000, 'Torlan')
    await setServicePrice(est.id, ids.polish, 20000, 'Torlan')
    await setServicePrice(est.id, ids.wash, 12500, 'Torlan')      // rapid re-edit
    await setServicePrice(est.id, ids.interior, 33000, 'Torlan')
    const view = await getEstimateView(orderId)
    expect(prices(view)).toEqual({ 'Wash': 12500, 'Interior Detail': 33000, 'Polish': 20000 })
    expect(view.workTotalCents).toBe(65500)
  })

  it('navigate away + reopen mid-incomplete does not fabricate prices; reference persists', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await setExplicitPrice(est.id, 60000, 'Torlan')
    await recomputeEstimate(est.id)
    await itemizeEstimate(est.id, 'Torlan')
    const v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Wash'), 10000, 'Torlan')
    const reopened = await prepareEstimateView(orderId, 'Torlan')   // seedSuggestedPrices + recompute run here
    expect(prices(reopened)).toEqual({ 'Wash': 10000, 'Interior Detail': null, 'Polish': null })
    expect(reopened.incomplete).toBe(true)
    expect(reopened.referenceCents).toBe(60000)
  })

  it('rejected Work Total override returns the persisted amounts (UI never shows an unsaved value)', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    let v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Wash'), 10000, 'Torlan'); v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Interior Detail'), 30000, 'Torlan')
    // The server ignores the override; the value it returns is the saved one ($400), so the client
    // renders server truth rather than the $999 the user typed.
    await setWorkTotal(est.id, 99900, 'Torlan')
    const view = await getEstimateView(orderId)
    expect(view.workTotalCents).toBe(40000)
    expect(prices(view)).toEqual({ 'Wash': 10000, 'Interior Detail': 30000 })
  })
})

describe('explicit $0 is a valid free service and stays distinct from an untouched (unpriced) service', () => {
  it('an explicit $0 counts as priced/complete; an untouched service stays null — and both survive reopen', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    let v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Wash'), 0, 'Torlan')       // explicit free service
    v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Interior Detail'), 30000, 'Torlan')
    // Polish left untouched.
    v = await getEstimateView(orderId)
    expect(prices(v)).toEqual({ 'Wash': 0, 'Interior Detail': 30000, 'Polish': null }) // $0 ≠ null
    expect(v.incomplete).toBe(true)   // Polish is untouched → still incomplete

    // Price the last one → complete (the $0 is a real, priced service, not "missing").
    await setServicePrice(est.id, serviceId(v, 'Polish'), 20000, 'Torlan')
    v = await getEstimateView(orderId)
    expect(v.incomplete).toBe(false)
    expect(prices(v)).toEqual({ 'Wash': 0, 'Interior Detail': 30000, 'Polish': 20000 })

    // The $0 and the amounts survive navigation + reopen (not reseeded, not coerced to null).
    const reopened = await prepareEstimateView(orderId, 'Torlan')
    expect(prices(reopened)).toEqual({ 'Wash': 0, 'Interior Detail': 30000, 'Polish': 20000 })
  })
})

describe('completing itemization never silently replaces the agreed amount with a different total', () => {
  async function draftFor(orderId: string) {
    const order = await getOrderWithContext(orderId)
    const full = await getFullEstimate(orderId)
    return buildInvoiceDraft({ order: order!, full, paymentLabel: 'Card', role: 'admin' })
  }
  async function flatThreeService(total: number) {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await setExplicitPrice(est.id, total, 'Torlan')
    await recomputeEstimate(est.id)
    await itemizeEstimate(est.id, 'Torlan')
    return { orderId, est }
  }

  it('itemized sum DIFFERS from agreed → reference retained, difference visible, invoice blocked until accepted', async () => {
    const { orderId, est } = await flatThreeService(60000)   // agreed $600
    let v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Wash'), 10000, 'Torlan'); v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Interior Detail'), 30000, 'Torlan'); v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Polish'), 15000, 'Torlan')   // sum $550 ≠ $600

    v = await getEstimateView(orderId)
    expect(v.incomplete).toBe(false)             // every service priced
    expect(v.referenceCents).toBe(60000)         // but the agreed amount is RETAINED (difference stands)
    expect(v.workTotalCents).toBe(55000)
    const d = await draftFor(orderId)
    expect(d.pricingIncomplete).toBe(false)
    expect(d.referenceCents).toBe(60000)         // draft still exposes the agreed amount to show the diff
    expect(d.workPriceCents).toBe(55000)         // both are pre-tax WORK prices

    // Manager accepts the itemized total → reference cleared, $550 is authoritative.
    await acceptItemizedTotal(est.id, 'Torlan')
    v = await getEstimateView(orderId)
    expect(v.referenceCents).toBeNull()
    expect(v.workTotalCents).toBe(55000)
    expect((await draftFor(orderId)).referenceCents).toBeNull()
  })

  it('itemized sum EQUALS agreed → reference auto-dropped (nothing to reconcile)', async () => {
    const { orderId, est } = await flatThreeService(60000)
    let v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Wash'), 10000, 'Torlan'); v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Interior Detail'), 30000, 'Torlan'); v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Polish'), 20000, 'Torlan')   // sum $600 == agreed
    v = await getEstimateView(orderId)
    expect(v.incomplete).toBe(false)
    expect(v.referenceCents).toBeNull()          // matched → no reconciliation needed
    expect(v.workTotalCents).toBe(60000)
  })

  it('acceptItemizedTotal is a no-op while pricing is still incomplete (agreed amount not dropped)', async () => {
    const { orderId, est } = await flatThreeService(60000)
    const v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Wash'), 10000, 'Torlan')   // only 1 of 3 priced
    await acceptItemizedTotal(est.id, 'Torlan')                            // should NOT drop the reference
    const after = await getEstimateView(orderId)
    expect(after.incomplete).toBe(true)
    expect(after.referenceCents).toBe(60000)
  })
})

describe('reference keeps its pre-tax WORK meaning — no double-counting into fees/tax/total/production', () => {
  async function draftFor(orderId: string) {
    const order = await getOrderWithContext(orderId)
    const full = await getFullEstimate(orderId)
    return buildInvoiceDraft({ order: order!, full, paymentLabel: 'Card', role: 'admin' })
  }

  it('while incomplete: fees compute on the partial WORK sum, reference is separate, production shows the reference', async () => {
    const orderId = await newRetailOrder(['Wash', 'Interior Detail', 'Polish'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await setExplicitPrice(est.id, 60000, 'Torlan')   // agreed $600 pre-tax work
    await recomputeEstimate(est.id)
    await itemizeEstimate(est.id, 'Torlan')
    const v = await getEstimateView(orderId)
    await setServicePrice(est.id, serviceId(v, 'Wash'), 10000, 'Torlan')   // partial work = $100

    const d = await draftFor(orderId)
    // Work basis is the partial $100, NOT the $600 reference (the reference is shown separately).
    expect(d.workPriceCents).toBe(10000)
    expect(d.referenceCents).toBe(60000)
    // Shop supplies are 3% of the WORK basis ($100 → $3), proving fees are NOT computed on the
    // reference and the reference is not folded into the total (no double-count).
    expect(d.shopSupplies.cents).toBe(300)
    expect(d.totalCents).toBeLessThan(60000)          // partial-based total, far below the agreed $600

    // Production value precedence uses the retained pre-tax reference while incomplete (not the
    // partial sum) — so reporting shows the agreed amount, consistently.
    const row = await getEstimateRow(orderId)
    const itemizedSubtotal = d.workPriceCents
    expect(retailProductionValueCents({
      explicitTotalCents: row!.explicitTotalCents, itemizedSubtotalCents: itemizedSubtotal, agreedPriceCents: row!.agreedPriceCents,
    })).toBe(60000)
  })
})
