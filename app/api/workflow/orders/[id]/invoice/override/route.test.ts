/**
 * POST /invoice/override — flipping a retail charge through the single fee engine, under the intake lock
 * for an open estimate. Regression focus: the order is re-read UNDER the lock, so a cancel or a Work
 * Board conversion that wins the race between the status check and acquiring the lock is REJECTED (never
 * applied to a stale read). Also: the waiver persists and restores, and carries over to the Work Board.
 *
 * PGlite + real schema and real estimate paths (createIntake / moveIntakeToBoard / the fee engine). The
 * only seam is withIntakeLock, wrapped so a test can mutate the order in the lock's race window; no
 * QuickBooks and no network. Never touches an external database.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
const auth = vi.hoisted(() => ({ role: 'manager' as string | null }))
// Runs inside the (wrapped) intake lock's race window, BEFORE the real lock + the route's re-read.
const lockHook = vi.hoisted(() => ({ before: null as null | (() => Promise<void> | void) }))

vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  // Fees ON so a waiver visibly changes real cents. Reference: $20 supplies (3% cap), 3% card charge.
  getBusinessConfig: async () => ({ shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000, paymentEnabled: true, paymentBps: 300, paymentLabel: 'Card Payment', paymentBasis: 'work_plus_supplies', defaultTaxBps: 0 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => (auth.role ? { name: 'Mgr', role: auth.role } : null),
  employeeAuthorizedFromRequest: async () => !!auth.role,
}))
vi.mock('@/apps/estimates/db', async (orig) => {
  const actual = await orig<typeof import('@/apps/estimates/db')>()
  return {
    ...actual,
    withIntakeLock: async <T>(id: string, work: () => Promise<T>): Promise<T> => {
      if (lockHook.before) await lockHook.before()
      return actual.withIntakeLock(id, work)
    },
  }
})

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { createIntake, moveIntakeToBoard } from '@/apps/estimates/db'
import { jobEstimates, serviceOrders, serviceOrderEvents } from '@/drizzle/schema'
import { POST } from './route'

let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  // Neon's db.batch (used by createIntake) — PGlite's driver has none; run the statements in order.
  Object.assign(db, { batch: async (qs: Promise<unknown>[]) => { const out = []; for (const q of qs) out.push(await q); return out } })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
  auth.role = 'manager'
  lockHook.before = null
})

async function newEstimate() {
  const id = crypto.randomUUID()
  await createIntake({ requestId: id, customerName: 'TEST Customer', customerEmail: '', customerPhone: '', year: '2020', make: 'TEST', model: 'Car', vin: '',
    vehicleId: null, notes: '', lines: [{ name: 'Headlight Restoration', priceCents: 15000 }], workPriceCents: null }, 'Mgr')
  return id
}
const override = (id: string, body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const estOf = async (id: string) => (await db.select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, id)))[0]
const overrideEvents = async (id: string) => (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, id))).filter((e) => e.eventType === 'invoice_override')

describe('override on an open estimate — happy path through the fee engine', () => {
  it('removes a charge, persists the waiver, returns the recomputed draft, and audits once', async () => {
    const id = await newEstimate()
    const res = await override(id, { field: 'payment', removed: true })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; draft: { paymentCharge: { cents: number; waived: boolean }; shopSupplies: { cents: number } } }
    expect(body.ok).toBe(true)
    expect(body.draft.paymentCharge).toMatchObject({ waived: true, cents: 0 })
    expect(body.draft.shopSupplies.cents).toBe(450)   // 3% of $150 work, still billed
    expect((await estOf(id)).waiveCardFee).toBe(true)
    expect(await overrideEvents(id)).toHaveLength(1)
  })

  it('restores the charge again (waiver back to false), audited a second time', async () => {
    const id = await newEstimate()
    await override(id, { field: 'payment', removed: true })
    const res = await override(id, { field: 'payment', removed: false })
    expect(res.status).toBe(200)
    expect((await res.json() as { draft: { paymentCharge: { waived: boolean; cents: number } } }).draft.paymentCharge).toMatchObject({ waived: false })
    expect((await estOf(id)).waiveCardFee).toBe(false)
    expect(await overrideEvents(id)).toHaveLength(2)
  })

  it('a no-op (already in that state) returns the draft without a new audit row', async () => {
    const id = await newEstimate()
    const res = await override(id, { field: 'payment', removed: false })   // already not waived
    expect(res.status).toBe(200)
    expect(await overrideEvents(id)).toHaveLength(0)
  })

  it('managers only — an employee is refused and nothing changes', async () => {
    const id = await newEstimate()
    auth.role = 'employee'
    expect((await override(id, { field: 'payment', removed: true })).status).toBe(403)
    expect((await estOf(id)).waiveCardFee).toBe(false)
  })
})

describe('race between the status read and the lock — re-read under the lock wins', () => {
  it('a cancellation that wins the race is rejected (409); no waiver, no audit', async () => {
    const id = await newEstimate()
    lockHook.before = async () => { await db.update(serviceOrders).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(serviceOrders.id, id)) }
    const res = await override(id, { field: 'payment', removed: true })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/moved to the Work Board or cancelled/)
    expect((await estOf(id)).waiveCardFee).toBe(false)
    expect(await overrideEvents(id)).toHaveLength(0)
  })

  it('a Work Board conversion that wins the race is rejected (409); no waiver, no audit', async () => {
    const id = await newEstimate()
    lockHook.before = async () => { await moveIntakeToBoard(id, 'Mgr') }
    const res = await override(id, { field: 'shop_supplies', removed: true })
    expect(res.status).toBe(409)
    expect((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status).toBe('arrived')
    expect((await estOf(id)).waiveShopSupplies).toBe(false)
    expect(await overrideEvents(id)).toHaveLength(0)
  })
})

describe('fee choice persists and carries to the Work Board', () => {
  it('a waiver set on the estimate carries over when it moves, and the moved Job can restore it', async () => {
    const id = await newEstimate()
    expect((await override(id, { field: 'shop_supplies', removed: true })).status).toBe(200)
    expect((await estOf(id)).waiveShopSupplies).toBe(true)

    await moveIntakeToBoard(id, 'Mgr')
    expect((await estOf(id)).waiveShopSupplies).toBe(true)   // same estimate row — the choice carried over

    // On the Work Board (no longer an estimate) the override takes the unlocked path and still works.
    const res = await override(id, { field: 'shop_supplies', removed: false })
    expect(res.status).toBe(200)
    expect((await res.json() as { draft: { shopSupplies: { waived: boolean; cents: number } } }).draft.shopSupplies).toMatchObject({ waived: false, cents: 450 })
    expect((await estOf(id)).waiveShopSupplies).toBe(false)
  })
})
