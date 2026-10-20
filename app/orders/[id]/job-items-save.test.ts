/**
 * Job page item editing really persists. The Job page (useJobItems in JobItems.tsx) and the Estimate /
 * Invoice page share ONE save path — saveEstimateEdit → POST /api/workflow/orders/[id]/estimate — and
 * the fee controls share the override route. This drives those REAL routes against an in-memory PGlite
 * database (no QuickBooks, no network) to prove the behaviour the arithmetic unit tests can't: a service
 * rename / price and a part edit are stored and read back, with no duplicate rows, the Job's completedAt
 * is never disturbed, and a fee removal / restore persists.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
const auth = vi.hoisted(() => ({ role: 'manager' as string | null }))
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000, paymentEnabled: true, paymentBps: 300, paymentLabel: 'Card Payment', paymentBasis: 'work_plus_supplies', defaultTaxBps: 0 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => (auth.role ? { name: 'Mgr', role: auth.role } : null),
  employeeAuthorizedFromRequest: async () => !!auth.role,
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, getEstimateView } from '@/apps/workflow/estimate-db'
import { saveEstimateEdit } from './estimate/save-feedback'
import { vehicles, serviceOrders, jobServices, jobEstimates } from '@/drizzle/schema'
import { POST as estimateRoute } from '@/app/api/workflow/orders/[id]/estimate/route'
import { POST as overrideRoute } from '@/app/api/workflow/orders/[id]/invoice/override/route'

let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  process.env.ESTIMATE_LAYER_ENABLED = 'true'
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
  auth.role = 'manager'
})

// The exact fetch the client uses, pointed at the real route handler. Parsing the id from the URL means
// saveEstimateEdit's own URL building is exercised too. keepalive is dropped (node Request doesn't need it).
const routeFetch = ((url: string, init: RequestInit) => {
  const id = url.match(/orders\/([^/]+)\/estimate/)![1]
  return estimateRoute(new Request('http://x' + url, { method: init.method, headers: init.headers as HeadersInit, body: init.body as BodyInit }), { params: Promise.resolve({ id }) })
}) as unknown as typeof fetch
const fee = (id: string, body: unknown) => overrideRoute(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const save = (id: string, edit: Record<string, unknown> & { action: string }) => saveEstimateEdit(id, edit, routeFetch)
const estOf = async (id: string) => (await db.select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, id)))[0]

const COMPLETED_AT = new Date('2026-01-02T03:04:05.000Z')
async function job() {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2019' }).returning()
  // A finished retail Job (not an estimate) — the Job page editor path, and completedAt must never move.
  const [o] = await db.insert(serviceOrders).values({ orderNumber: 'RT-1', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', completedAt: COMPLETED_AT }).returning()
  const est = await getOrCreateEstimate(o.id, 'Mgr')
  const svc = await addService(est.id, 'Interior Detail', { actor: 'Mgr' })
  return { orderId: o.id, estimateId: est.id, serviceId: svc.id }
}
const completedAtOf = async (id: string) => (await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].completedAt

describe('service rename persists through the shared save path', () => {
  it('stores the new name, reflects it on reload and on the Job list, and never duplicates the row', async () => {
    const { orderId, estimateId, serviceId } = await job()
    const out = await save(orderId, { action: 'rename_service', serviceId, title: 'Full Interior Detail' })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.view.services.find((s) => s.id === serviceId)?.title).toBe('Full Interior Detail')

    // Reload straight from the database — independent of the response the save returned.
    const view = await getEstimateView(orderId)
    expect(view.services.map((s) => s.title)).toEqual(['Full Interior Detail'])   // exactly one, renamed
    expect((await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, estimateId)))).toHaveLength(1)
    expect((await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId)))[0].services).toEqual(['Full Interior Detail'])
    expect((await completedAtOf(orderId))?.getTime()).toBe(COMPLETED_AT.getTime())
  })
})

describe('service price persists through the shared save path', () => {
  it('stores the price, derives the Work Total, reads back, and leaves completedAt untouched', async () => {
    const { orderId, serviceId } = await job()
    const out = await save(orderId, { action: 'set_service_price', serviceId, cents: 20000 })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.view.services.find((s) => s.id === serviceId)?.priceCents).toBe(20000)

    const view = await getEstimateView(orderId)
    expect(view.services.find((s) => s.id === serviceId)?.priceCents).toBe(20000)
    expect(view.workTotalCents).toBe(20000)
    expect(view.incomplete).toBe(false)
    expect((await completedAtOf(orderId))?.getTime()).toBe(COMPLETED_AT.getTime())
  })

  it('a failed server confirmation is surfaced as a failure (no false "Saved")', async () => {
    const { orderId, serviceId } = await job()
    // A fetch that returns ok but a view that does NOT reflect the edit → saveEstimateEdit reports failure.
    const liar = (async () => new Response(JSON.stringify({ ok: true, view: { exists: true, flat: false, workTotalCents: 0, services: [{ id: serviceId, title: 'Interior Detail', priceCents: 0, suggestedCents: null }], incomplete: false, referenceCents: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    const out = await saveEstimateEdit(orderId, { action: 'set_service_price', serviceId, cents: 20000 }, liar)
    expect(out.ok).toBe(false)
  })
})

describe('part edits persist through the shared save path', () => {
  it('adds a part then updates its name and price, reading the one updated row back', async () => {
    const { orderId } = await job()
    const add = await save(orderId, { action: 'add_part', part: { description: 'Cabin filter', supply: 'shop', sellPriceCents: 3000, quantity: 1 } })
    expect(add.ok).toBe(true)
    const part = (await getEstimateView(orderId)).parts!.find((p) => p.description === 'Cabin filter')!
    expect(part).toBeTruthy()

    const upd = await save(orderId, { action: 'update_part', partId: part.id, patch: { description: 'Cabin air filter', sellPriceCents: 3500 } })
    expect(upd.ok).toBe(true)

    const parts = (await getEstimateView(orderId)).parts!
    expect(parts.filter((p) => p.id === part.id)).toHaveLength(1)   // updated in place, not duplicated
    expect(parts.find((p) => p.id === part.id)).toMatchObject({ description: 'Cabin air filter', sellPriceCents: 3500 })
    expect((await completedAtOf(orderId))?.getTime()).toBe(COMPLETED_AT.getTime())
  })
})

describe('fee removal / restore persists (same override route the Job page uses)', () => {
  it('removes shop supplies, persists the waiver and recomputes, then restores it', async () => {
    const { orderId, serviceId } = await job()
    await save(orderId, { action: 'set_service_price', serviceId, cents: 20000 })

    const removed = await fee(orderId, { field: 'shop_supplies', removed: true })
    expect(removed.status).toBe(200)
    expect((await removed.json() as { draft: { shopSupplies: { waived: boolean; cents: number } } }).draft.shopSupplies).toMatchObject({ waived: true, cents: 0 })
    expect((await estOf(orderId)).waiveShopSupplies).toBe(true)

    const restored = await fee(orderId, { field: 'shop_supplies', removed: false })
    expect(restored.status).toBe(200)
    expect((await restored.json() as { draft: { shopSupplies: { waived: boolean; cents: number } } }).draft.shopSupplies).toMatchObject({ waived: false, cents: 600 })
    expect((await estOf(orderId)).waiveShopSupplies).toBe(false)
    expect((await completedAtOf(orderId))?.getTime()).toBe(COMPLETED_AT.getTime())
  })
})
