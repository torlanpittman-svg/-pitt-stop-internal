/**
 * Estimate API — the part-review actions are manager/admin only (enforced on the server), and the
 * manager path converts / clarifies through the real route. PGlite + real schema; no QB/network.
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
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => (auth.role ? { name: 'Someone', role: auth.role } : null),
  employeeAuthorizedFromRequest: async () => !!auth.role,
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, addLine } from '@/apps/workflow/estimate-db'
import { serviceOrders, vehicles, jobParts, jobServices } from '@/drizzle/schema'
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
  auth.role = 'manager'
})

async function jobWithPartLine() {
  const [v] = await db.insert(vehicles).values({ make: 'Ford' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: 'RT-1', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
  const est = await getOrCreateEstimate(o.id, 'M')
  const svc = await addService(est.id, 'Driver mirror assembly', { actor: 'M' })
  await addLine(svc.id, { type: 'labor', name: 'Driver mirror assembly', description: null, qty: 1, unit: 'each', costCents: 0, priceCents: 26500, taxable: false, taxCategory: 'detailing' })
  return { orderId: o.id, serviceId: svc.id }
}
const call = (orderId: string, body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: orderId }) })

describe('estimate part-review actions — server-side permissions', () => {
  it('employees and signed-out users cannot convert or clarify (403), and nothing changes', async () => {
    const { orderId, serviceId } = await jobWithPartLine()
    for (const role of ['employee', null]) {
      auth.role = role
      expect((await call(orderId, { action: 'convert_to_part', serviceId })).status).toBe(403)
      expect((await call(orderId, { action: 'clarify_part', serviceId, part: { description: 'Mirror' } })).status).toBe(403)
    }
    expect(await db.select().from(jobParts)).toHaveLength(0)
    expect((await db.select().from(jobServices).where(eq(jobServices.id, serviceId)))[0].kind).toBe('service')
  })

  it('a manager converts through the route; the returned view confirms it (what the Saved status checks)', async () => {
    const { orderId, serviceId } = await jobWithPartLine()
    const res = await call(orderId, { action: 'convert_to_part', serviceId, part: { fitment: '2019 Ford F-150' } })
    const body = await res.json() as { ok: boolean; view: { services: unknown[]; parts: Array<{ serviceId: string; lineCents: number; invoiceText: string; laborStatus: string }> } }
    expect(body.ok).toBe(true)
    expect(body.view.services).toEqual([])
    expect(body.view.parts[0]).toMatchObject({ serviceId, lineCents: 26500, laborStatus: 'needs_review', invoiceText: 'Driver mirror assembly — Fits: 2019 Ford F-150' })
  })

  it('a refused conversion returns a plain error and changes nothing (input kept for retry)', async () => {
    const { orderId } = await jobWithPartLine()
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
    const est = await getOrCreateEstimate(o.id, 'M')
    const paint = await addService(est.id, 'Paint mirror covers', { actor: 'M' })
    const res = await call(orderId, { action: 'convert_to_part', serviceId: paint.id })
    expect(res.status).toBe(500)
    expect((await res.json() as { error: string }).error).toMatch(/describes work, not a part/)
    expect(await db.select().from(jobParts)).toHaveLength(0)
  })
})
