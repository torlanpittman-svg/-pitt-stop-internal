/**
 * REGRESSION (red): a physical PART entered as a service line must be caught on an existing,
 * un-invoiced estimate and convertible to a real part WITHOUT losing money or history.
 *
 * Gaps exercised here:
 *   1. The estimate review surfaces a `service_as_part` issue and blocks invoice readiness until a
 *      decision is made (job completion is never gated — covered elsewhere).
 *   2. A NEW conversion (`convertServiceToPart`) turns the flagged service line into a job_parts
 *      record + installation-labor review, PRESERVING the original price, quantity, tax flag, line
 *      total, and the employee's raw wording — no delete/recreate of the job, no double charge.
 *   3. Conversion refuses a line that is genuine labor ("Paint driver-side mirror") or already has an
 *      identity, so legitimate services are never silently turned into parts.
 *   4. A linked QuickBooks invoice is flagged "sync needed", never silently rewritten.
 *
 * In-memory PGlite from the real Drizzle schema + the production-shaped catalog + migration 0052.
 * No real DB/QB/network. Fails on baseline: `service_as_part` and `convertServiceToPart` do not exist.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq, and } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, addLine, getEstimateView } from '@/apps/workflow/estimate-db'
import { loadEstimateReview } from '@/apps/workflow/estimate-review'
import * as estimateParts from '@/apps/parts/estimate-parts'
import { serviceOrders, vehicles, jobServices, jobLineItems, jobParts, jobEstimates, serviceOrderEvents } from '@/drizzle/schema'

// Proposed conversion API (red until implemented). Keeps raw wording, price, qty, tax, total.
type ConvertInput = { supply?: 'shop' | 'customer'; fitment?: string | null; partNumber?: string | null; supplier?: string | null }
type ConvertFn = (orderId: string, serviceId: string, input: ConvertInput, actor: string | null) => Promise<{ id: string }>
const convertServiceToPart = (estimateParts as unknown as { convertServiceToPart?: ConvertFn }).convertServiceToPart

let db: PgliteDatabase<typeof schema>
let CAT: Record<string, string> = {}
let seq = 0

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

async function order() {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2019' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `SAP-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived', customerName: 'Test Customer' }).returning()
  const est = await getOrCreateEstimate(o.id, 'Manager')
  return { orderId: o.id, estimateId: est.id }
}
/** A service line that is really a physical part, priced + TAXABLE so we can prove tax is preserved. */
async function partTypedAsService(estimateId: string) {
  const svc = await addService(estimateId, 'Driver-side mirror assembly', { entryText: 'dr mirr assy', actor: 'Manager' })
  await addLine(svc.id, { type: 'labor', name: 'Driver-side mirror assembly', description: 'Driver-side mirror assembly', qty: 1, unit: 'each', costCents: 0, priceCents: 26500, taxable: true, taxCategory: 'repair_parts' })
  return svc
}
const events = async (orderId: string, type: string) =>
  (await db.select().from(serviceOrderEvents).where(and(eq(serviceOrderEvents.serviceOrderId, orderId), eq(serviceOrderEvents.eventType, type)))).map((e) => JSON.parse(e.note ?? '{}'))

describe('service-as-part — detection gates invoicing', () => {
  it('a part typed as a service blocks invoice readiness with a service_as_part issue', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const review = await loadEstimateReview(orderId)
    expect(review.readiness.ready).toBe(false)
    const issue = review.readiness.issues.find((i) => (i.code as string) === 'service_as_part')
    expect(issue?.ids).toContain(svc.id)
    // Surfaced on the manager estimate view too.
    const v = await getEstimateView(orderId)
    expect(v.review!.issues.map((i) => i.code as string)).toContain('service_as_part')
  })
})

describe('service-as-part — conversion preserves money, tax, and history', () => {
  it('convertServiceToPart is implemented', () => {
    expect(convertServiceToPart).toBeTypeOf('function')
  })

  it('converts the flagged line to a part: same price/qty/tax/total/raw wording, labor review opens, no double charge', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const beforeWorkTotal = (await getEstimateView(orderId)).workTotalCents   // pre-fee/pre-tax eligible sum
    expect(beforeWorkTotal).toBe(26500)

    await convertServiceToPart!(orderId, svc.id, { supply: 'shop', fitment: '2019 Ford F-150', partNumber: 'FL3Z-17683' }, 'Manager')

    const v = await getEstimateView(orderId)
    // The work no longer appears as a service; it is now exactly one part.
    expect(v.services.find((s) => s.id === svc.id)).toBeUndefined()
    expect(v.parts).toHaveLength(1)
    const part = v.parts![0]
    expect(part).toMatchObject({ supply: 'shop', laborStatus: 'needs_review', quantity: 1, sellPriceCents: 26500, lineCents: 26500 })
    expect(part.invoiceText).toMatch(/Driver-side mirror assembly/)

    // The ONE priced line is preserved as-is: price, qty, and the TAXABLE flag survive (not forced NON).
    const partRow = (await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId)))[0]
    const line = (await db.select().from(jobLineItems).where(eq(jobLineItems.id, partRow.jobLineItemId!)))[0]
    expect({ price: line.priceCents, qty: Number(line.qty), taxable: line.taxable }).toEqual({ price: 26500, qty: 1, taxable: true })
    expect(partRow.description).toBe('Driver-side mirror assembly')
    const svcRow = (await db.select().from(jobServices).where(eq(jobServices.id, partRow.jobServiceId!)))[0]
    expect(svcRow.kind).toBe('part')
    expect(svcRow.entryText).toBe('dr mirr assy')   // the employee's raw wording survives

    // No money invented or doubled: the pre-tax work total is unchanged by the conversion.
    expect((await getEstimateView(orderId)).workTotalCents).toBe(beforeWorkTotal)

    // The gate moves from service_as_part to the normal parts-labor review.
    const review = await loadEstimateReview(orderId)
    expect(review.readiness.issues.map((i) => i.code as string)).toEqual(['part_labor'])
    expect(await events(orderId, 'service_converted_to_part')).toHaveLength(1)
  })

  it('refuses to convert genuine labor or an already-identified service (never silently turns a service into a part)', async () => {
    const { orderId, estimateId } = await order()
    const paint = await addService(estimateId, 'Paint driver-side mirror', { actor: 'Manager' })
    await expect(convertServiceToPart!(orderId, paint.id, {}, 'Manager')).rejects.toThrow()
    const matched = await addService(estimateId, 'Interior Detail', { catalogId: CAT.interior_detail, matchMethod: 'exact', actor: 'Manager' })
    await expect(convertServiceToPart!(orderId, matched.id, {}, 'Manager')).rejects.toThrow()
  })

  it('a linked QuickBooks invoice is flagged for sync, never silently rewritten', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    await db.update(jobEstimates).set({ qbInvoiceId: 'INV-OLD', qbInvoiceNumber: '100800' }).where(eq(jobEstimates.id, estimateId))
    await convertServiceToPart!(orderId, svc.id, { supply: 'shop' }, 'Manager')
    const [e] = await db.select().from(jobEstimates).where(eq(jobEstimates.id, estimateId))
    expect(e.qbInvoiceId).toBe('INV-OLD')   // untouched
    expect(e.qbSyncError).toMatch(/sync needed/i)
  })
})

describe('service-as-part — retries, clarification, reopening, and real-data wording', () => {
  it('a retried or double-tapped conversion creates exactly ONE part and ONE audit event', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const [a, b] = await Promise.all([
      convertServiceToPart!(orderId, svc.id, { supply: 'shop' }, 'Manager'),
      convertServiceToPart!(orderId, svc.id, { supply: 'shop' }, 'Manager').catch((e: Error) => e),
    ])
    const again = await convertServiceToPart!(orderId, svc.id, { supply: 'shop' }, 'Manager')
    const live = (await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId)))
    expect(live).toHaveLength(1)
    expect(again.id).toBe(live[0].id)
    expect([a, b].some((x) => (x as { id?: string }).id === live[0].id)).toBe(true)
    expect(await events(orderId, 'service_converted_to_part')).toHaveLength(1)
    expect((await getEstimateView(orderId)).workTotalCents).toBe(26500)
  })

  it('the conversion and the part/labor link survive reopening the estimate (no service re-created from the Work Board label)', async () => {
    const { orderId, estimateId } = await order()
    await db.update(serviceOrders).set({ services: ['Driver-side mirror assembly', 'Paint mirror covers'] }).where(eq(serviceOrders.id, orderId))
    const { prepareEstimateView } = await import('@/apps/workflow/estimate-db')
    await prepareEstimateView(orderId, 'Manager')
    const rows = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
    const mirror = rows.find((r) => r.title === 'Driver-side mirror assembly')!
    const paint = rows.find((r) => r.title === 'Paint mirror covers')!
    expect((await loadEstimateReview(orderId)).readiness.issues.find((i) => i.code === 'service_as_part')!.ids).toEqual([mirror.id])   // painting is work, not flagged
    const part = await convertServiceToPart!(orderId, mirror.id, {}, 'Manager')
    // Painting the mirror is NOT installing it — the link must be explicit, and refuses a part row.
    await expect(estimateParts.decidePartLabor(orderId, part.id, { action: 'included', serviceId: mirror.id }, 'Manager', 'manager')).rejects.toThrow()
    await estimateParts.decidePartLabor(orderId, part.id, { action: 'add_labor', cents: 7500 }, 'Manager', 'manager')
    for (let i = 0; i < 2; i++) await prepareEstimateView(orderId, 'Manager')   // reopen twice
    const v = await getEstimateView(orderId)
    expect(v.services.map((s) => s.title).sort()).toEqual(['Installation Labor', 'Paint mirror covers'])
    expect(v.parts).toHaveLength(1)
    expect(v.parts![0]).toMatchObject({ description: 'Driver-side mirror assembly', laborStatus: 'labor_added' })
    expect(v.review!.issues).toEqual([])   // pricing is never a readiness gate; the part is now reviewed
    expect(paint.kind).toBe('service')
  })

  it('"Replace windshield" is ambiguous: clarify keeps the line + its price as labor and links a separately added part (no split, no double charge)', async () => {
    const { orderId, estimateId } = await order()
    const svc = await addService(estimateId, 'Replace windshield', { actor: 'Manager' })
    await addLine(svc.id, { type: 'labor', name: 'Replace windshield', description: null, qty: 1, unit: 'each', costCents: 0, priceCents: 45000, taxable: false, taxCategory: 'detailing' })
    expect((await getEstimateView(orderId)).services[0].partLike).toBe('ambiguous')
    const part = await estimateParts.clarifyServiceWithPart(orderId, svc.id, { description: 'Windshield', supply: 'customer' }, 'Manager', 'manager')
    const retry = await estimateParts.clarifyServiceWithPart(orderId, svc.id, { description: 'Windshield', supply: 'customer' }, 'Manager', 'manager')
    expect(retry.id).toBe(part.id)
    const v = await getEstimateView(orderId)
    expect(v.services).toHaveLength(1)
    expect(v.services[0]).toMatchObject({ title: 'Replace windshield', priceCents: 45000, matchState: 'custom', partLike: null })
    expect(v.parts).toEqual([expect.objectContaining({ description: 'Windshield', supply: 'customer', laborStatus: 'included', laborServiceId: svc.id })])
    expect(v.workTotalCents).toBe(45000)
    expect(v.review!.ready).toBe(true)
    // Removing the labor line re-opens the part's review.
    const { removeEstimateService } = await import('@/apps/workflow/estimate-db')
    await removeEstimateService(orderId, svc.id, 'Manager')
    expect((await loadEstimateReview(orderId)).readiness.issues.map((i) => i.code)).toEqual(['part_labor'])
  })

  it('"It\'s a service" is an explicit, audited decision that clears the review without touching price', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const { selectServiceMatch } = await import('@/apps/workflow/estimate-db')
    await selectServiceMatch(orderId, svc.id, { custom: true }, 'Manager')
    const r = await loadEstimateReview(orderId)
    expect(r.readiness.ready).toBe(true)
    expect((await getEstimateView(orderId)).workTotalCents).toBe(26500)
    expect(await events(orderId, 'service_matched')).toHaveLength(1)
  })

  it('a line with several price lines is never converted wholesale (must be clarified)', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    await addLine(svc.id, { type: 'labor', name: 'labor', description: null, qty: 1, unit: 'each', costCents: 0, priceCents: 5000, taxable: false, taxCategory: 'detailing' })
    await expect(convertServiceToPart!(orderId, svc.id, {}, 'Manager')).rejects.toThrow(/several prices/)
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId))).toHaveLength(0)
  })
})
