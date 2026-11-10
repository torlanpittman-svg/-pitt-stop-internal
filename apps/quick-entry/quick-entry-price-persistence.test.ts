/**
 * REGRESSION — Quick Entry per-service prices must reach the invoice and survive opening it.
 *
 * Reported data loss: a manager entered a price for each service in Quick Entry, saved the Job, opened
 * "View / Edit Invoice", changed nothing and backed out — and the Job lost its individual prices and
 * its total.
 *
 * Cause: intake stored the entered prices ONLY as the "expected" audit (job_estimates.agreed_price_cents
 * + agreed_meta), never as the services' price lines. The invoice reads price lines, so it found none,
 * and merely opening it (prepareEstimateView → seedSuggestedPrices) WROTE catalog default prices for the
 * catalog-matched services. Those new lines then outranked the entered total everywhere (itemized
 * subtotal beats the intake amount), so the Job's value silently changed without anyone editing it.
 *
 * In-memory PGlite from the real Drizzle schema + the production-shaped catalog. No DB/QB/network.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
// Real retail charges ON (3% shop supplies capped at $20 + 3% card charge on work + supplies), so the
// totals below go through the one fee engine exactly as production does.
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000, paymentEnabled: true, paymentBps: 300, paymentLabel: 'Card charge', paymentBasis: 'work_plus_supplies', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))

import { seedProductionCatalog, CLEAR_TABLES } from './catalog-fixture.test-support'
import { createQuickEntryJob, type CreateJobInput, type JobLineInput } from './jobs-db'
import { prepareEstimateView, getEstimateView, getFullEstimate, setServicePrice, getEstimateRow } from '@/apps/workflow/estimate-db'
import { getOrderRetailWorkValueCents } from '@/apps/workflow/production'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { getOrderWithContext } from '@/apps/workflow/db'
import { jobEstimates, jobLineItems, jobServices, serviceOrderEvents, serviceOrders } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let CAT: Record<string, string> = {}

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  CAT = await seedProductionCatalog(db)
})

const base = { customerName: 'Pat Driver', vehicle: { year: '2019', make: 'Ford', model: 'F-150' }, createdBy: 'Torlan' }

/** Exactly what the Quick Entry screen sends for a set of lines (see QuickEntryFlow.createJob). */
function intake(lines: JobLineInput[], extra: Partial<CreateJobInput> = {}): CreateJobInput {
  const entered = lines.filter((l) => l.priceCents > 0 || l.priceEntered)
  return {
    ...base, lines,
    agreedPriceCents: lines.reduce((s, l) => s + l.priceCents, 0) || null,
    agreedServices: entered.map((l) => ({ originalText: l.entryText || l.name, confirmedCents: l.priceCents })),
    ...extra,
  }
}

// Headlight Restoration's catalog default is $150 and Mini Detail's is $150 — both entered DIFFERENTLY.
const threeLines = (): JobLineInput[] => [
  { kind: 'addon', name: 'Headlight Restoration', catalogId: CAT.headlight_restoration, priceCents: 12000, matchMethod: 'shortcut' },  // manual override of $150
  { kind: 'custom', name: 'Pet hair removal', priceCents: 8550 },
  { kind: 'package', name: 'Mini Detail', catalogId: CAT.mini_detail, priceCents: 17500, matchMethod: 'shortcut' },
]
const prices = (v: { services: { title: string; priceCents: number | null }[] }) => Object.fromEntries(v.services.map((s) => [s.title, s.priceCents]))

/** Everything persisted that carries a price for the Job — to prove an action changed nothing. */
async function pricingSnapshot(orderId: string) {
  const full = (await getFullEstimate(orderId))!
  const e = full.estimate
  return {
    estimate: { priceMode: e.priceMode, explicitTotalCents: e.explicitTotalCents, agreedPriceCents: e.agreedPriceCents, totalCents: e.totalCents, taxCents: e.taxCents,
      nontaxableSubtotalCents: e.nontaxableSubtotalCents, taxableSubtotalCents: e.taxableSubtotalCents },
    lines: full.services.flatMap((s) => s.lines.map((l) => ({ service: s.title, name: l.name, priceCents: l.priceCents, qty: String(l.qty), generated: l.generated, feeCode: l.feeCode })))
      .sort((a, b) => `${a.service}|${a.name}`.localeCompare(`${b.service}|${b.name}`)),
    workValue: await getOrderRetailWorkValueCents(orderId),
  }
}
async function draftFor(orderId: string) {
  return buildInvoiceDraft({ order: (await getOrderWithContext(orderId))!, full: await getFullEstimate(orderId), paymentLabel: 'Card charge', role: 'manager' })
}

describe('Quick Entry prices are saved as the services’ own prices', () => {
  it('several services with different manually entered prices each keep their price', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(threeLines()))
    // Saved at intake — before anyone opens the invoice.
    expect(prices(await getEstimateView(id))).toEqual({ 'Headlight Restoration': 12000, 'Pet hair removal': 8550, 'Mini Detail': 17500 })
    expect(await getOrderRetailWorkValueCents(id)).toBe(38050)
  })

  it('opening View / Edit Invoice shows the entered prices — never the catalog defaults — with fees from the one engine', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(threeLines()))
    const view = await prepareEstimateView(id, 'Torlan')
    expect(prices(view)).toEqual({ 'Headlight Restoration': 12000, 'Pet hair removal': 8550, 'Mini Detail': 17500 })
    expect(view).toMatchObject({ flat: false, incomplete: false, workTotalCents: 38050, referenceCents: null })
    const d = await draftFor(id)
    // $380.50 work → shop supplies 3% = $11.42 (under the $20 cap) → card charge 3% of $391.92 = $11.76.
    expect(d).toMatchObject({ priced: true, itemized: true, pricingIncomplete: false, workPriceCents: 38050, totalCents: 38050 + 1142 + 1176 })
    expect(d.shopSupplies.cents).toBe(1142)
    expect(d.paymentCharge.cents).toBe(1176)
    expect(d.serviceBreakdown).toEqual([
      { title: 'Headlight Restoration', cents: 12000 }, { title: 'Pet hair removal', cents: 8550 }, { title: 'Mini Detail', cents: 17500 },
    ])
  })

  it('a manual override and an intentional $0 service are both kept exactly; a blank price stays unpriced', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake([
      { kind: 'addon', name: 'Headlight Restoration', catalogId: CAT.headlight_restoration, priceCents: 9900, matchMethod: 'shortcut' },   // override of $150
      { kind: 'addon', name: 'Leather Conditioner', catalogId: CAT.leather_conditioner, priceCents: 0, priceEntered: true, matchMethod: 'shortcut' },  // free on purpose (catalog $50)
      { kind: 'addon', name: 'Clay Bar', catalogId: CAT.clay_bar, priceCents: 0, matchMethod: 'shortcut' },                                 // left blank (catalog $200)
    ]))
    const expected = { 'Headlight Restoration': 9900, 'Leather Conditioner': 0, 'Clay Bar': null }
    expect(prices(await getEstimateView(id))).toEqual(expected)
    // Opening must not fill the blank from the catalog, nor turn the $0 into the $50 default.
    const view = await prepareEstimateView(id, 'Torlan')
    expect(prices(view)).toEqual(expected)
    expect(view.incomplete).toBe(true)   // one service still needs a price — said plainly, never guessed
    expect(await getOrderRetailWorkValueCents(id)).toBe(9900)
  })

  it('an employee’s entered prices are saved the same way (a manager still creates/sends the invoice)', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(threeLines(), { createdBy: 'Tony' }))
    expect(prices(await prepareEstimateView(id, 'Torlan'))).toEqual({ 'Headlight Restoration': 12000, 'Pet hair removal': 8550, 'Mini Detail': 17500 })
    const est = (await getEstimateRow(id))!
    expect(est).toMatchObject({ priceMode: 'itemized', explicitTotalCents: null, agreedPriceCents: 38050, qbInvoiceId: null })
  })

  it('a service with a job-specific area keeps its price (the row is titled "name — area")', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake([
      { kind: 'package', name: 'Seat Shampoo', catalogId: CAT.seat_shampoo, priceCents: 6500, entryText: 'shamp pass seat', detail: 'passenger seat', matchMethod: 'suggestion' },
      { kind: 'custom', name: 'Pet hair removal', priceCents: 4000 },
    ]))
    const view = await prepareEstimateView(id, 'Torlan')
    expect(view.services.map((s) => s.priceCents)).toEqual([6500, 4000])
    expect(view.workTotalCents).toBe(10500)
  })

  it('a manager flat Work Price still wins exactly as before (no per-service lines are written)', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(threeLines(), { workPriceCents: 40000 }))
    const view = await prepareEstimateView(id, 'Torlan')
    expect(view).toMatchObject({ flat: true, workTotalCents: 40000 })
    expect(view.services.every((s) => s.priceCents == null)).toBe(true)
    expect(await getOrderRetailWorkValueCents(id)).toBe(40000)
  })
})

describe('opening, closing or backing out of the invoice never changes saved pricing', () => {
  it('open → back out → refresh → reopen leaves every price, fee and total byte-for-byte identical', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(threeLines()))
    const saved = await pricingSnapshot(id)
    expect(saved.workValue).toBe(38050)
    const [{ n: eventsBefore }] = (await db.execute(`SELECT count(*)::int AS n FROM service_order_events`)).rows as { n: number }[]

    const first = await prepareEstimateView(id, 'Torlan')       // open View / Edit Invoice
    expect(await pricingSnapshot(id)).toEqual(saved)             // …and back out without touching anything
    const second = await prepareEstimateView(id, 'Torlan')      // refresh
    const third = await prepareEstimateView(id, 'Darryl')       // reopen later, another manager
    expect(await pricingSnapshot(id)).toEqual(saved)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    // The Job's own service list is untouched too, and viewing wrote no audit noise.
    const [order] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, id))
    expect(order.services).toEqual(['Headlight Restoration', 'Pet hair removal', 'Mini Detail'])
    const [{ n: eventsAfter }] = (await db.execute(`SELECT count(*)::int AS n FROM service_order_events`)).rows as { n: number }[]
    expect(eventsAfter).toBe(eventsBefore)
  })

  it('the read-only load (GET view) writes nothing either', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(threeLines()))
    const saved = await pricingSnapshot(id)
    await getEstimateView(id); await getEstimateView(id)
    expect(await pricingSnapshot(id)).toEqual(saved)
  })
})

describe('a real price edit saves only that price', () => {
  it('editing one service leaves every other price intact, on the invoice, the Job and the Work Board value', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(threeLines()))
    const view = await prepareEstimateView(id, 'Torlan')
    const est = (await getEstimateRow(id))!
    const pet = view.services.find((s) => s.title === 'Pet hair removal')!
    await setServicePrice(est.id, pet.id, 10000, 'Torlan')

    const after = await prepareEstimateView(id, 'Torlan')   // refresh
    expect(prices(after)).toEqual({ 'Headlight Restoration': 12000, 'Pet hair removal': 10000, 'Mini Detail': 17500 })
    expect(after.workTotalCents).toBe(39500)
    expect(await getOrderRetailWorkValueCents(id)).toBe(39500)                      // Job detail + Work Board + Production
    const d = await draftFor(id)
    expect(d.workPriceCents).toBe(39500)
    expect(d.totalCents).toBe(39500 + 1185 + 1221)                                   // 3% supplies, 3% card on work + supplies
    // Changing a price to $0 on purpose is a real edit and is kept as $0 (not "unpriced", not the catalog default).
    const mini = after.services.find((s) => s.title === 'Mini Detail')!
    await setServicePrice(est.id, mini.id, 0, 'Torlan')
    expect(prices(await prepareEstimateView(id, 'Torlan'))).toEqual({ 'Headlight Restoration': 12000, 'Pet hair removal': 10000, 'Mini Detail': 0 })
  })
})

describe('Jobs saved before this fix (prices only in the intake record)', () => {
  /** Recreate a pre-fix Job: services promoted, entered prices ONLY in agreed_price_cents/agreed_meta. */
  async function legacyJob(lines: JobLineInput[], meta?: Array<{ originalText: string; confirmedCents: number }>) {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(lines))
    const est = (await getEstimateRow(id))!
    const svcIds = (await db.select({ id: jobServices.id }).from(jobServices).where(eq(jobServices.jobEstimateId, est.id))).map((s) => s.id)
    for (const sid of svcIds) await db.delete(jobLineItems).where(eq(jobLineItems.jobServiceId, sid))
    // The old record shape: the per-service audit only — no "saved onto the lines" stamp.
    const services = meta ?? ((est.agreedMeta as { services: unknown[] }).services)
    await db.update(jobEstimates).set({ agreedMeta: { services, enteredBy: 'Tony', at: '2026-11-01T00:00:00.000Z' } as never }).where(eq(jobEstimates.id, est.id))
    await db.update(jobEstimates).set({ totalCents: 0, nontaxableSubtotalCents: 0 }).where(eq(jobEstimates.id, est.id))
    return id
  }

  it('reproduces the report on the old data shape: opening no longer writes catalog prices over the entered total', async () => {
    // Entries that cannot be tied to a service one-to-one → nothing is guessed and nothing is seeded.
    const id = await legacyJob(threeLines(), [{ originalText: 'lights', confirmedCents: 12000 }, { originalText: 'dog hair', confirmedCents: 8550 }, { originalText: 'mini', confirmedCents: 17500 }])
    expect(await getOrderRetailWorkValueCents(id)).toBe(38050)
    const view = await prepareEstimateView(id, 'Torlan')
    // Before the fix this came back { Headlight Restoration: 15000, Pet hair removal: null, Mini Detail: 15000 }
    // and the Job's value dropped from $380.50 to $300.00 just from looking.
    expect(prices(view)).toEqual({ 'Headlight Restoration': null, 'Pet hair removal': null, 'Mini Detail': null })
    expect(await getOrderRetailWorkValueCents(id)).toBe(38050)
    expect((await getEstimateRow(id))!.agreedPriceCents).toBe(38050)
  })

  it('carries the saved intake prices onto the invoice when every one matches a service exactly — once, with an audit event', async () => {
    const id = await legacyJob(threeLines())
    const view = await prepareEstimateView(id, 'Torlan')
    expect(prices(view)).toEqual({ 'Headlight Restoration': 12000, 'Pet hair removal': 8550, 'Mini Detail': 17500 })
    expect(await getOrderRetailWorkValueCents(id)).toBe(38050)   // same value as before opening
    const events = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, id))
    expect(events.filter((e) => e.eventType === 'intake_prices_applied')).toHaveLength(1)
    const saved = await pricingSnapshot(id)
    await prepareEstimateView(id, 'Torlan')                      // reopening does nothing further
    expect(await pricingSnapshot(id)).toEqual(saved)
    expect((await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, id))).filter((e) => e.eventType === 'intake_prices_applied')).toHaveLength(1)
  })

  it('never applies a partial or ambiguous set (sum must equal the saved total, each entry one service)', async () => {
    // Two services with the same wording → ambiguous.
    const dup = await legacyJob([{ kind: 'custom', name: 'Buff scratch', priceCents: 5000 }, { kind: 'custom', name: 'Pet hair removal', priceCents: 4000 }],
      [{ originalText: 'Buff scratch', confirmedCents: 5000 }, { originalText: 'Buff scratch', confirmedCents: 4000 }])
    expect(prices(await prepareEstimateView(dup, 'Torlan'))).toEqual({ 'Buff scratch': null, 'Pet hair removal': null })
    expect(await getOrderRetailWorkValueCents(dup)).toBe(9000)
    // Entries don't add up to the saved total → not trusted.
    const off = await legacyJob([{ kind: 'custom', name: 'Buff scratch', priceCents: 5000 }, { kind: 'custom', name: 'Pet hair removal', priceCents: 4000 }],
      [{ originalText: 'Buff scratch', confirmedCents: 5000 }, { originalText: 'Pet hair removal', confirmedCents: 1000 }])
    expect(prices(await prepareEstimateView(off, 'Torlan'))).toEqual({ 'Buff scratch': null, 'Pet hair removal': null })
    expect(await getOrderRetailWorkValueCents(off)).toBe(9000)
  })
})

describe('an entered amount that has no single line of its own is kept visible, never dropped', () => {
  it('a shop-supplied part keeps its entered price as its customer price', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake([
      { kind: 'custom', name: 'Driver-side mirror', priceCents: 18900, partSupply: 'shop' },
      { kind: 'custom', name: 'Pet hair removal', priceCents: 4000 },
    ]))
    const view = await prepareEstimateView(id, 'Torlan')
    expect(view.parts!.map((p) => [p.description, p.sellPriceCents])).toEqual([['Driver-side mirror', 18900]])
    expect(prices(view)).toEqual({ 'Pet hair removal': 4000 })
    expect(view).toMatchObject({ workTotalCents: 22900, referenceCents: null })
    expect(await getOrderRetailWorkValueCents(id)).toBe(22900)
  })

  it('tire work entered with one amount: the full entered total stays as the agreed reference', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake([
      { kind: 'custom', name: 'Replace tires', priceCents: 60000, tires: { mode: 'supply', quantity: 4 } },
      { kind: 'custom', name: 'Pet hair removal', priceCents: 4000 },
    ]))
    const saved = await pricingSnapshot(id)
    expect(saved.workValue).toBe(64000)                          // Job value = everything that was entered
    const view = await prepareEstimateView(id, 'Torlan')
    expect(prices(view)).toEqual({ 'Pet hair removal': 4000 })    // saved where it belongs
    expect(view.parts!.map((p) => [p.description, p.quantity, p.sellPriceCents])).toEqual([['Tires', 4, null]])   // one tire row, no duplicate service
    expect(view).toMatchObject({ flat: false, incomplete: true, referenceCents: 64000 })   // tires still need a per-tire price
    expect(await pricingSnapshot(id)).toEqual(saved)              // and opening changed nothing
  })
})

describe('a missing or unloaded amount can never overwrite a saved price', () => {
  it('setServicePrice refuses a non-number and a line that is not on this invoice — nothing changes', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake(threeLines()))
    const other = await createQuickEntryJob(intake([{ kind: 'custom', name: 'Buff scratch', priceCents: 5000 }], { customerName: 'Sam Other' }))
    const saved = await pricingSnapshot(id)
    const savedOther = await pricingSnapshot(other.serviceOrderId)
    const est = (await getEstimateRow(id))!
    const view = await getEstimateView(id)
    const foreign = (await getEstimateView(other.serviceOrderId)).services[0]
    await expect(setServicePrice(est.id, view.services[0].id, Number.NaN, 'Torlan')).rejects.toThrow(/dollar amount/)
    await expect(setServicePrice(est.id, view.services[0].id, -1, 'Torlan')).rejects.toThrow(/dollar amount/)
    await expect(setServicePrice(est.id, foreign.id, 100, 'Torlan')).rejects.toThrow(/no longer on this invoice/)
    await expect(setServicePrice(est.id, '00000000-0000-4000-8000-000000000000', 100, 'Torlan')).rejects.toThrow(/no longer on this invoice/)
    expect(await pricingSnapshot(id)).toEqual(saved)
    expect(await pricingSnapshot(other.serviceOrderId)).toEqual(savedOther)
  })

  it('intake ignores junk amounts instead of saving them as prices', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob({ ...base, lines: [
      { kind: 'custom', name: 'Buff scratch', priceCents: Number.NaN },
      { kind: 'custom', name: 'Pet hair removal', priceCents: -500, priceEntered: true },
      { kind: 'custom', name: 'Wipe down', priceCents: undefined as unknown as number },
      { kind: 'custom', name: 'Vacuum', priceCents: 2500 },
    ], agreedPriceCents: 2500, agreedServices: [{ originalText: 'Vacuum', confirmedCents: 2500 }] })
    expect(prices(await prepareEstimateView(id, 'Torlan'))).toEqual({ 'Buff scratch': null, 'Pet hair removal': null, 'Wipe down': null, 'Vacuum': 2500 })
  })
})

describe('a Job with no entered prices keeps the existing draft behaviour', () => {
  it('still offers catalog starting prices on first open (nothing was entered to protect)', async () => {
    const { serviceOrderId: id } = await createQuickEntryJob(intake([
      { kind: 'addon', name: 'Headlight Restoration', catalogId: CAT.headlight_restoration, priceCents: 0, matchMethod: 'shortcut' },
    ]))
    expect(prices(await prepareEstimateView(id, 'Torlan'))).toEqual({ 'Headlight Restoration': 15000 })
  })
})
