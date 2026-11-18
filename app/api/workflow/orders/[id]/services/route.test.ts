/**
 * DELETE /api/workflow/orders/[id]/services — the confirmed removal must affect only the
 * selected occurrence, and a stale selection must return 409 and change nothing. Runs the
 * REAL route handler and persistence against an in-memory PGlite Postgres; only identity
 * is mocked.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/auth/employee-guard', () => ({ authenticatedActorFromRequest: vi.fn() }))

import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { serviceOrders, vehicles } from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { DELETE } from './route'

let db: PgliteDatabase<typeof schema>
let orderSeq = 0

async function newRetailOrder(services: string[]): Promise<string> {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'Transit', year: '2021' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: `SO-TEST-${++orderSeq}`, vehicleId: v.id,
    source: 'quick_entry', serviceType: 'retail', status: 'arrived', services,
  }).returning()
  return o.id
}

const del = (id: string, body: unknown) =>
  DELETE(new Request(`http://localhost/api/workflow/orders/${id}/services`, { method: 'DELETE', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) })

async function currentServices(id: string): Promise<string[]> {
  const [row] = await db.select({ services: serviceOrders.services }).from(serviceOrders).where(eq(serviceOrders.id, id)).limit(1)
  return row?.services ?? []
}

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})

beforeEach(async () => {
  for (const t of ['job_parts', 'job_line_items', 'job_services', 'job_estimates', 'service_order_events', 'service_orders', 'vehicles']) {
    await db.execute(`DELETE FROM ${t}`)
  }
  vi.mocked(authenticatedActorFromRequest).mockResolvedValue({ key: 'test-manager', name: 'Test Manager', role: 'manager' })
})

describe('service removal route — selected line only, stale fails closed', () => {
  it('rejects employees (manager/admin only)', async () => {
    vi.mocked(authenticatedActorFromRequest).mockResolvedValue({ key: 'test-staff', name: 'Test Staff', role: 'employee' })
    const id = await newRetailOrder(['Wash'])
    const res = await del(id, { service: 'Wash', index: 0, expectedServices: ['Wash'] })
    expect(res.status).toBe(403)
    expect(await currentServices(id)).toEqual(['Wash'])
  })

  it('removes exactly the tapped duplicate, leaving the other occurrence and other lines alone', async () => {
    const id = await newRetailOrder(['Wash', 'Polish', 'Wash'])
    const res = await del(id, { service: 'Wash', index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })
    const d = await res.json()
    expect(res.status).toBe(200)
    expect(d).toMatchObject({ ok: true, changed: true })
    expect(await currentServices(id)).toEqual(['Wash', 'Polish'])
  })

  it('a stale snapshot returns 409 and removes nothing (double-submit/retry protection)', async () => {
    const id = await newRetailOrder(['Wash', 'Polish', 'Wash'])
    // First removal succeeds…
    await del(id, { service: 'Wash', index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })
    // …and the duplicated/retried identical request must NOT take the remaining Wash.
    const res = await del(id, { service: 'Wash', index: 2, expectedServices: ['Wash', 'Polish', 'Wash'] })
    const d = await res.json()
    expect(res.status).toBe(409)
    expect(d.ok).toBe(false)
    expect(d.error).toMatch(/refresh/i)
    expect(await currentServices(id)).toEqual(['Wash', 'Polish'])
  })

  it('an already-gone service is a calm no-op (ok, changed: false)', async () => {
    const id = await newRetailOrder(['Wash'])
    const res = await del(id, { service: 'Wax', index: 0, expectedServices: ['Wash'] })
    const d = await res.json()
    expect(res.status).toBe(200)
    expect(d).toMatchObject({ ok: true, changed: false })
    expect(await currentServices(id)).toEqual(['Wash'])
  })
})
