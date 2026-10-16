/**
 * REGRESSION (red): the employee's RAW wording captured at Quick Entry intake must survive into the
 * authoritative job_services identity, exactly as the manager estimate path already records it.
 *
 * Gap: the Quick Entry flow interprets an entry (raw text + scope), confirms it, and sends the
 * per-service audit (agreedServices[].originalText) to the jobs endpoint — but promoteTextServices
 * writes only the title, so job_services.entry_text stays NULL. The original wording (needed to
 * explain/trace a match, and to drive the service-as-part and odor reviews) is lost once the Job is
 * on the board.
 *
 * In-memory PGlite from the real Drizzle schema + the production-shaped catalog. No DB/QB/network.
 * Fails on baseline because createQuickEntryJob does not persist the raw entry text onto job_services.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
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

import { seedProductionCatalog, CLEAR_TABLES } from './catalog-fixture.test-support'
import { createQuickEntryJob } from './jobs-db'
import { prepareEstimateView, getEstimateView } from '@/apps/workflow/estimate-db'
import { jobServices, jobEstimates } from '@/drizzle/schema'

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

async function servicesFor(serviceOrderId: string) {
  const [est] = await db.select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, serviceOrderId))
  return db.select().from(jobServices).where(eq(jobServices.jobEstimateId, est.id))
}

describe('Quick Entry intake → job_services preserves the employee raw wording', () => {
  it('records the original typed entry as entry_text on the promoted service', async () => {
    const res = await createQuickEntryJob({
      customerName: 'Pat Driver',
      vehicle: { year: '2019', make: 'Ford', model: 'F-150' },
      lines: [{ kind: 'custom', name: 'Seat Shampoo', priceCents: 0 }],
      // What the employee actually typed, confirmed against the catalog at intake.
      agreedServices: [{ originalText: 'shamp pass seat', matchedDisplay: 'Seat Shampoo', confirmedCents: 6000 }],
      agreedPriceCents: 6000,
      createdBy: 'Tony',
    })
    const rows = (await servicesFor(res.serviceOrderId)).filter((r) => r.title !== 'Fees & Charges')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Seat Shampoo', entryText: 'shamp pass seat' })
  })

  it('keeps the exact catalog identity AND the raw wording together for a tapped shortcut', async () => {
    const res = await createQuickEntryJob({
      customerName: 'Dana Owner',
      vehicle: { year: '2020', make: 'Kia', model: 'Soul' },
      lines: [{ kind: 'addon', name: 'Leather Conditioner', catalogId: CAT.leather_conditioner, priceCents: 0 }],
      agreedServices: [{ originalText: 'lthr condtnr seats', matchedDisplay: 'Leather Conditioner', confirmedCents: 5000 }],
      createdBy: 'Tony',
    })
    const rows = (await servicesFor(res.serviceOrderId)).filter((r) => r.title !== 'Fees & Charges')
    expect(rows[0]).toMatchObject({ title: 'Leather Conditioner', catalogId: CAT.leather_conditioner, entryText: 'lthr condtnr seats' })
  })
})

describe('Quick Entry intake → interpreted lines become the right estimate rows', () => {
  const base = { vehicle: { year: '2019', make: 'Ford', model: 'F-150' }, createdBy: 'Tony' }

  it('a matched service keeps its identity, the area, and the typed wording — and the estimate shows "approved text — area"', async () => {
    const res = await createQuickEntryJob({ ...base, customerName: 'Pat Driver',
      lines: [{ kind: 'package', name: 'Seat Shampoo', catalogId: CAT.seat_shampoo, priceCents: 0, entryText: 'shamp pass seat', detail: 'passenger seat', matchMethod: 'suggestion' }] })
    const v = await prepareEstimateView(res.serviceOrderId, 'Tony')
    expect(v.services).toHaveLength(1)
    expect(v.services[0]).toMatchObject({ catalogId: CAT.seat_shampoo, detail: 'passenger seat', entryText: 'shamp pass seat', matchMethod: 'suggestion',
      description: 'Seat Shampoo — passenger seat', qbMapped: true, priceCents: null })
  })

  it('a confirmed part becomes a real part with an open installation-labor review — never also a service, even after reopening', async () => {
    const res = await createQuickEntryJob({ ...base, customerName: 'Jamie Parts',
      lines: [{ kind: 'custom', name: 'Driver-side mirror assembly', priceCents: 0, entryText: 'dr side mirror assy', partSupply: 'shop' },
        { kind: 'package', name: 'Painting / Refinishing', catalogId: CAT.paint_refinish, priceCents: 0, entryText: 'paint dr mirr assy', detail: 'driver-side mirror assembly', matchMethod: 'suggestion' }] })
    for (let i = 0; i < 2; i++) await prepareEstimateView(res.serviceOrderId, 'Manager')
    const v = await getEstimateView(res.serviceOrderId)
    expect(v.services.map((s) => s.title)).toEqual(['Painting / Refinishing — driver-side mirror assembly'])
    expect(v.parts).toEqual([expect.objectContaining({ description: 'Driver-side mirror assembly', supply: 'shop', laborStatus: 'needs_review', sellPriceCents: null })])
    expect(v.review!.issues.map((i) => i.code)).toEqual(['part_labor'])   // painting ≠ installing
    const [row] = (await db.select().from(jobServices)).filter((r) => r.kind === 'part')
    expect(row.entryText).toBe('dr side mirror assy')
  })

  it('clarified tires: install customer-supplied tires → a no-charge customer part + installation labor (no price invented); never re-created on reopen', async () => {
    const res = await createQuickEntryJob({ ...base, customerName: 'Tire Person',
      lines: [{ kind: 'custom', name: '4 tires — install customer’s tires', priceCents: 0, entryText: 'replace tires', tires: { mode: 'install_customer', quantity: 4 } }] })
    for (let i = 0; i < 2; i++) await prepareEstimateView(res.serviceOrderId, 'Manager')
    const v = await getEstimateView(res.serviceOrderId)
    expect(v.parts).toEqual([expect.objectContaining({ description: 'Customer-supplied tires', supply: 'customer', laborStatus: 'labor_added' })])
    expect(v.services).toEqual([expect.objectContaining({ catalogId: CAT.installation_labor, detail: '4 customer-supplied tires', priceCents: null })])
    expect(v.review!.ready).toBe(true)
  })

  it('unclear entries kept as typed are never lost and still get the manager review (odor choice / part check)', async () => {
    const res = await createQuickEntryJob({ ...base, customerName: 'Kept Typed',
      lines: [{ kind: 'custom', name: 'car smells bad', priceCents: 0, entryText: 'car smells bad' }, { kind: 'custom', name: 'dr side mirror assy', priceCents: 0, entryText: 'dr side mirror assy' }] })
    const v = await prepareEstimateView(res.serviceOrderId, 'Manager')
    expect(v.services.map((s) => s.title).sort()).toEqual(['car smells bad', 'dr side mirror assy'])
    expect(v.review!.issues.map((i) => i.code).sort()).toEqual(['odor_choice', 'service_as_part'])
  })

  it('a client cannot smuggle an unknown catalog id, a bogus tire count, or junk fields — they fall back to plain text', async () => {
    const res = await createQuickEntryJob({ ...base, customerName: 'Bad Input',
      lines: [{ kind: 'package', name: 'Mystery', catalogId: '00000000-0000-0000-0000-000000000000', priceCents: 0, matchMethod: 'hacked' },
        { kind: 'custom', name: 'Tires', priceCents: 0, tires: { mode: 'both', quantity: 99 } }] as never })
    const v = await prepareEstimateView(res.serviceOrderId, 'Manager')
    expect(v.services.find((s) => s.title === 'Mystery')).toMatchObject({ catalogId: null })
    expect(v.parts).toEqual([])
  })

  it('removing a customer-supplied part from the estimate keeps it removed after reopening', async () => {
    const { removeEstimatePart } = await import('@/apps/parts/estimate-parts')
    const res = await createQuickEntryJob({ ...base, customerName: 'Remove Part',
      lines: [{ kind: 'custom', name: 'Customer mirror', priceCents: 0, partSupply: 'customer' }] })
    let v = await prepareEstimateView(res.serviceOrderId, 'Manager')
    await removeEstimatePart(res.serviceOrderId, v.parts![0].id, 'Manager')
    for (let i = 0; i < 2; i++) v = await prepareEstimateView(res.serviceOrderId, 'Manager')
    expect(v.parts).toEqual([])
    expect(v.services).toEqual([])
  })
})

describe('Quick Entry intake cannot skip the manager review', () => {
  it('a client-sent "custom" confirmation is ignored — part and odor wording are still reviewed', async () => {
    const res = await createQuickEntryJob({ vehicle: { make: 'Ford' }, createdBy: 'Tony', customerName: 'Tamper',
      lines: [{ kind: 'custom', name: 'Driver mirror assembly', priceCents: 0, matchMethod: 'custom' }, { kind: 'custom', name: 'Odor treatment', priceCents: 0, matchMethod: 'custom' }] })
    const v = await prepareEstimateView(res.serviceOrderId, 'Manager')
    expect(v.services.every((s) => s.matchMethod !== 'custom')).toBe(true)
    expect(v.review!.issues.map((i) => i.code).sort()).toEqual(['odor_choice', 'service_as_part'])
  })
})
