/**
 * Cash / Check amount preview (Record Payment): projectEstimateTotalCents must be the SAME engine as the
 * stored totals — previewing "card charge removed" equals what recomputeEstimate stores (and the Invoice
 * Draft shows) once the waiver is actually applied, for itemized and flat jobs. The preview never writes.
 * Real estimate-db functions on an in-memory PGlite with the real schema and default fee settings
 * (shop supplies 3% cap $20, card-payment charge 3%).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

import {
  getOrCreateEstimate, promoteTextServices, setExplicitPrice, recomputeEstimate, setServicePrice,
  getEstimateView, getFullEstimate, getEstimateRow, setEstimateWaiver, projectEstimateTotalCents,
} from '@/apps/workflow/estimate-db'
import { getOrderWithContext } from '@/apps/workflow/db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { serviceOrders, vehicles, jobLineItems } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0

async function newOrder(services: string[], source = 'quick_entry', serviceType = 'retail'): Promise<string> {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'Transit', year: '2021' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `SO-FEE-${++seq}`, vehicleId: v.id, source, serviceType, status: 'ready', services }).returning()
  return o.id
}
async function draftFor(orderId: string) {
  const order = (await getOrderWithContext(orderId))!
  return buildInvoiceDraft({ order, full: await getFullEstimate(orderId), paymentLabel: 'Card Payment', role: 'admin' })
}
const lineCount = async () => (await db.select().from(jobLineItems)).length

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of ['job_line_items', 'job_services', 'job_estimates', 'service_order_events', 'service_orders', 'vehicles']) await db.execute(`DELETE FROM ${t}`)
})

/** Preview, then actually waive + recompute: the stored total / Invoice Draft equal the preview. */
async function previewThenApply(orderId: string) {
  const est = (await getEstimateRow(orderId))!
  const before = await draftFor(orderId)
  const linesBefore = await lineCount()
  const projected = await projectEstimateTotalCents(est.id, { waiveCardFee: true })
  // The preview wrote nothing.
  expect(await lineCount()).toBe(linesBefore)
  expect((await getEstimateRow(orderId))!.totalCents).toBe(before.totalCents)
  expect((await getEstimateRow(orderId))!.waiveCardFee).toBe(false)
  // No override → the current total.
  expect(await projectEstimateTotalCents(est.id, {})).toBe(before.totalCents)

  expect(await setEstimateWaiver(est.id, 'payment', true)).toBe(true)
  await recomputeEstimate(est.id)
  const after = await draftFor(orderId)
  expect(after.totalCents).toBe(projected)
  expect((await getEstimateRow(orderId))!.totalCents).toBe(projected)
  expect(after.paymentCharge).toMatchObject({ cents: 0, waived: true })
  return { before, after, projected: projected! }
}

describe('Cash / Check preview = the pricing engine with the card charge removed', () => {
  it('itemized job: only the card-payment charge goes; shop supplies and services are unchanged', async () => {
    const orderId = await newOrder(['Wash', 'Interior Detail'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await promoteTextServices(est.id, orderId)
    await recomputeEstimate(est.id)
    let view = await getEstimateView(orderId)
    await setServicePrice(est.id, view.services.find((s) => s.title === 'Wash')!.id, 5000, 'Torlan')
    view = await getEstimateView(orderId)
    await setServicePrice(est.id, view.services.find((s) => s.title === 'Interior Detail')!.id, 15000, 'Torlan')

    const { before, after, projected } = await previewThenApply(orderId)
    expect(before.paymentCharge.cents).toBeGreaterThan(0)
    expect(projected).toBe(before.totalCents - before.paymentCharge.cents)
    expect(after.shopSupplies.cents).toBe(before.shopSupplies.cents)
  })

  it('flat (Work Price) job: the same engine path as the stored flat totals', async () => {
    const orderId = await newOrder(['Full Detail'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await setExplicitPrice(est.id, 20000, 'Torlan')
    await recomputeEstimate(est.id)
    const { before, projected } = await previewThenApply(orderId)
    expect(before.totalCents).toBe(20000 + 600 + 618)   // work + shop supplies 3% + card charge 3% of (work + supplies)
    expect(projected).toBe(20600)
  })

  it('a charge already waived (intentional manager waiver) → the preview is the current total', async () => {
    const orderId = await newOrder(['Full Detail'])
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await setExplicitPrice(est.id, 20000, 'Torlan')
    await setEstimateWaiver(est.id, 'payment', true)
    await recomputeEstimate(est.id)
    expect(await projectEstimateTotalCents(est.id, { waiveCardFee: true })).toBe((await getEstimateRow(orderId))!.totalCents)
    expect((await draftFor(orderId)).paymentCharge).toMatchObject({ cents: 0, waived: true })
  })

  it('dealer job: no retail charges, nothing to remove', async () => {
    const orderId = await newOrder(['Dealer Detail'], 'dealer', 'dealer')
    const est = await getOrCreateEstimate(orderId, 'Torlan')
    await setExplicitPrice(est.id, 12500, 'Torlan')
    await recomputeEstimate(est.id)
    expect((await getEstimateRow(orderId))!.totalCents).toBe(12500)
    expect(await projectEstimateTotalCents(est.id, { waiveCardFee: true })).toBe(12500)
  })
})
