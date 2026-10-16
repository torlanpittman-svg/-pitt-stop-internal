/**
 * Removing a part that has linked installation labor: the labor is kept or removed by explicit choice,
 * labor shared with another part can't be removed with it, the link is the persisted labor_service_id,
 * and retries after a partial failure finish the job without duplicate changes. PGlite + real schema.
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
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => ({ name: 'Mgr', role: 'manager' }),
  employeeAuthorizedFromRequest: async () => true,
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, removeEstimateService } from '@/apps/workflow/estimate-db'
import { addEstimatePart, decidePartLabor } from '@/apps/parts/estimate-parts'
import { interpretSave, type EstimateViewData } from '@/app/orders/[id]/estimate/save-feedback'
import { serviceOrders, vehicles, jobParts, jobServices, serviceOrderEvents } from '@/drizzle/schema'
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
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
})

const call = async (orderId: string, body: unknown) => {
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: orderId }) })
  return { status: res.status, body: await res.json() as { ok: boolean; error?: string; view: EstimateViewData } }
}
/** A job with one shop part whose installation labor was added ($100). */
async function partWithLabor() {
  const [v] = await db.insert(vehicles).values({ make: 'Ford' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `PL-${Math.floor(Math.random() * 1e9)}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
  await getOrCreateEstimate(o.id, 'Mgr')
  const part = await addEstimatePart(o.id, { description: 'Mirror glass', supply: 'shop', quantity: 1, sellPriceCents: 2000 }, 'Mgr')
  await decidePartLabor(o.id, part.id, { action: 'add_labor', cents: 10000 }, 'Mgr', 'manager')
  const [p] = await db.select().from(jobParts).where(eq(jobParts.id, part.id))
  return { orderId: o.id, partId: part.id, laborId: p.laborServiceId! }
}
const liveParts = async (orderId: string) => (await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId))).filter((p) => p.status !== 'cancelled')
const hasService = async (id: string) => (await db.select().from(jobServices).where(eq(jobServices.id, id))).length === 1
const events = async (orderId: string) => (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))).map((e) => e.eventType)
/** service_removed audit events per removed line id (a shop part bills through its own line). */
const removals = async (orderId: string) => {
  const rows = (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))).filter((e) => e.eventType === 'service_removed')
  const n: Record<string, number> = {}
  for (const r of rows) { const id = (JSON.parse(r.note ?? '{}') as { serviceId: string }).serviceId; n[id] = (n[id] ?? 0) + 1 }
  return n
}
const partLine = async (partId: string) => (await db.select().from(jobParts).where(eq(jobParts.id, partId)))[0].jobServiceId!

describe('remove a part with linked installation labor', () => {
  it('fixture: the part is linked to its labor line by labor_service_id', async () => {
    const { orderId, partId, laborId } = await partWithLabor()
    const v = (await call(orderId, { action: 'prepare' })).body.view
    expect(v.parts![0]).toMatchObject({ id: partId, laborStatus: 'labor_added', laborServiceId: laborId })
    expect(v.services.find((s) => s.id === laborId)).toMatchObject({ catalogName: 'Installation Labor', priceCents: 10000 })
  })

  it('keep: the part goes, the labor line (and its price) stays', async () => {
    const { orderId, partId, laborId } = await partWithLabor()
    const line = await partLine(partId)
    const r = await call(orderId, { action: 'remove_part', partId, labor: { action: 'keep' } })
    expect(r.status).toBe(200)
    expect(await liveParts(orderId)).toHaveLength(0)
    expect(r.body.view.services.find((s) => s.id === laborId)?.priceCents).toBe(10000)
    expect(await removals(orderId)).toEqual({ [line]: 1 })
  })

  it('remove: both go, each with its audit event; the response confirms both (what "Saved" checks)', async () => {
    const { orderId, partId, laborId } = await partWithLabor()
    const line = await partLine(partId)
    const edit = { action: 'remove_part', partId, labor: { action: 'remove', serviceId: laborId } }
    const r = await call(orderId, edit)
    expect(r.status).toBe(200)
    expect(await liveParts(orderId)).toHaveLength(0)
    expect(await hasService(laborId)).toBe(false)
    expect(r.body.view.workTotalCents).toBe(0)
    expect(await removals(orderId)).toEqual({ [laborId]: 1, [line]: 1 })
    expect(interpretSave(edit, { ok: true, status: 200 }, r.body)).toMatchObject({ ok: true })
  })

  it('shared labor can only be kept: removing it with the part is refused and nothing changes', async () => {
    const { orderId, partId, laborId } = await partWithLabor()
    const other = await addEstimatePart(orderId, { description: 'Mirror cover', supply: 'shop', quantity: 1, sellPriceCents: 1500 }, 'Mgr')
    await decidePartLabor(orderId, other.id, { action: 'included', serviceId: laborId }, 'Mgr', 'manager')
    const before = await events(orderId)
    const r = await call(orderId, { action: 'remove_part', partId, labor: { action: 'remove', serviceId: laborId } })
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/also covers “Mirror cover”/)
    expect(await liveParts(orderId)).toHaveLength(2)
    expect(await hasService(laborId)).toBe(true)
    expect(await events(orderId)).toEqual(before)
    // Keeping it works, and the other part stays covered.
    expect((await call(orderId, { action: 'remove_part', partId, labor: { action: 'keep' } })).status).toBe(200)
    const [o] = await liveParts(orderId)
    expect(o).toMatchObject({ id: other.id, laborStatus: 'included', laborServiceId: laborId })
  })

  it('only the persisted link counts: a labor line that isn’t this part’s is refused', async () => {
    const { orderId, partId } = await partWithLabor()
    const est = await getOrCreateEstimate(orderId, 'Mgr')
    const unrelated = await addService(est.id, 'Headlight Restoration', { custom: true, actor: 'Mgr' })
    const r = await call(orderId, { action: 'remove_part', partId, labor: { action: 'remove', serviceId: unrelated.id } })
    expect(r.status).toBe(500)
    expect(await hasService(unrelated.id)).toBe(true)
    expect(await liveParts(orderId)).toHaveLength(1)
  })

  it('retry after a partial failure (labor already removed, part still there) finishes without duplicates', async () => {
    const { orderId, partId, laborId } = await partWithLabor()
    const line = await partLine(partId)
    await removeEstimateService(orderId, laborId, 'Mgr')   // first attempt got this far, then failed
    expect(await liveParts(orderId)).toHaveLength(1)        // part still there; its labor review re-opened
    const edit = { action: 'remove_part', partId, labor: { action: 'remove', serviceId: laborId } }
    const r = await call(orderId, edit)
    expect(r.status).toBe(200)
    expect(await liveParts(orderId)).toHaveLength(0)
    expect(await removals(orderId)).toEqual({ [laborId]: 1, [line]: 1 })
    expect(interpretSave(edit, { ok: true, status: 200 }, r.body)).toMatchObject({ ok: true })
  })

  it('a repeated request after success (lost response) is a no-op success', async () => {
    const { orderId, partId, laborId } = await partWithLabor()
    const edit = { action: 'remove_part', partId, labor: { action: 'remove', serviceId: laborId } }
    await call(orderId, edit)
    const before = await events(orderId)
    const again = await call(orderId, edit)
    expect(again.status).toBe(200)
    expect(await events(orderId)).toEqual(before)
  })

  it('"Saved" is refused when the server view still lists the labor the user chose to remove', () => {
    const edit = { action: 'remove_part', partId: 'p1', labor: { action: 'remove', serviceId: 's9' } }
    const view: EstimateViewData = { exists: true, flat: false, workTotalCents: 10000, incomplete: false, referenceCents: null, parts: [],
      services: [{ id: 's9', title: 'Installation Labor', priceCents: 10000, suggestedCents: null }] }
    expect(interpretSave(edit, { ok: true, status: 200 }, { ok: true, view })).toEqual({ ok: false, error: 'The server still lists the installation labor.' })
  })
})
