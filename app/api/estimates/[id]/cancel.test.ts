/**
 * Cancelling standalone estimates: directly from the estimate (never via the Work Board), and after a
 * transfer + Work Board removal. Both read "Cancelled" in Estimates history, keep their links and audit,
 * and reject further edits. PGlite + real schema; no QuickBooks or network.
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
  authenticatedActorFromRequest: async () => (auth.role ? { name: 'Mgr', role: auth.role } : null),
  employeeAuthorizedFromRequest: async () => !!auth.role,
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { createIntake, moveIntakeToBoard, intakeStatus, listIntakes } from '@/apps/estimates/db'
import { removeOrder } from '@/apps/workflow/db'
import { serviceOrders, serviceOrderEvents, estimateIntakes, quickEntryJobs, jobEstimates } from '@/drizzle/schema'
import { POST as estimateAction } from './route'
import { POST as estimateEdit } from '@/app/api/workflow/orders/[id]/estimate/route'

let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  process.env.ESTIMATE_LAYER_ENABLED = 'true'
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
})

async function newQuote() {
  const id = crypto.randomUUID()
  await createIntake({ requestId: id, customerName: 'TEST Customer', customerEmail: '', customerPhone: '', year: '2020', make: 'TEST', model: 'Car', vin: '',
    vehicleId: null, notes: '', lines: [{ name: 'Headlight Restoration', priceCents: 15000 }], workPriceCents: null }, 'Mgr')
  return id
}
const act = (id: string, body: unknown) => estimateAction(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const edit = (id: string, body: unknown) => estimateEdit(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const events = async (id: string) => (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, id))).map((e) => e.eventType)
const statusOf = async (id: string) => {
  const row = (await listIntakes()).find((r) => r.order.id === id)!
  return intakeStatus(row.order, row.intake, row.estimate)
}

describe('Cancel estimate — directly, without the Work Board', () => {
  it('soft-cancels, keeps links and the QuickBooks estimate reference, audits once, and lists as Cancelled', async () => {
    const id = await newQuote()
    await db.update(estimateIntakes).set({ qbEstimateId: 'QB-EST-1', qbEstimateNumber: '1001' }).where(eq(estimateIntakes.orderId, id))
    const res = await act(id, { action: 'cancel' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, cancelled: true, alreadyCancelled: false })

    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, id))
    expect(o).toMatchObject({ status: 'cancelled', completedAt: null, arrivedAt: null, customerName: 'TEST Customer' })
    expect(o.cancelledAt).not.toBeNull()
    const [intake] = await db.select().from(estimateIntakes).where(eq(estimateIntakes.orderId, id))
    expect(intake).toMatchObject({ qbEstimateId: 'QB-EST-1', qbEstimateNumber: '1001', sentAt: null })   // untouched, nothing sent
    expect(await db.select().from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, id))).toHaveLength(1)
    const [est] = await db.select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, id))
    expect(est.convertedAt).toBeNull()
    expect((await events(id)).filter((e) => e === 'estimate_cancelled')).toHaveLength(1)
    expect(await statusOf(id)).toBe('Cancelled')
  })

  it('a retry / double-tap is a no-op success — no second audit event', async () => {
    const id = await newQuote()
    await act(id, { action: 'cancel' })
    const again = await act(id, { action: 'cancel' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ cancelled: true, alreadyCancelled: true })
    expect((await events(id)).filter((e) => e === 'estimate_cancelled')).toHaveLength(1)
  })

  it('a cancelled estimate rejects edits, renames, sends, and moves — nothing changes', async () => {
    const id = await newQuote()
    const before = await db.select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, id))
    await act(id, { action: 'cancel' })
    expect((await edit(id, { action: 'add_service', title: 'Exterior Wash' })).status).toBe(409)
    expect((await act(id, { action: 'customer_name', name: 'Other' })).status).toBe(409)
    expect((await act(id, { action: 'convert', revision: 'x'.repeat(64) })).status).toBe(409)
    expect((await act(id, { action: 'send', revision: 'x'.repeat(64) })).status).toBe(409)
    expect(await db.select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, id))).toEqual(before)
    const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, id))
    expect(o).toMatchObject({ status: 'cancelled', customerName: 'TEST Customer' })
  })

  it('only managers can cancel', async () => {
    const id = await newQuote()
    auth.role = 'employee'
    expect((await act(id, { action: 'cancel' })).status).toBe(403)
    expect((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status).toBe('estimate')
  })
})

describe('Cancelled after moving to the Work Board', () => {
  it('reads Cancelled (not "On Work Board"); Cancel estimate on a live Work Board job is refused', async () => {
    const id = await newQuote()
    await moveIntakeToBoard(id, 'Mgr')
    expect(await statusOf(id)).toBe('On Work Board')
    const refused = await act(id, { action: 'cancel' })
    expect(refused.status).toBe(409)
    expect((await refused.json() as { error: string }).error).toMatch(/Work Board/)
    expect((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status).toBe('arrived')

    expect((await removeOrder({ orderId: id, actor: 'Mgr' })).ok).toBe(true)
    expect(await statusOf(id)).toBe('Cancelled')
  })
})

describe('intakeStatus precedence', () => {
  const t = new Date()
  it.each([
    [{ status: 'estimate' }, { sentAt: null }, { convertedAt: null }, 'Draft'],
    [{ status: 'estimate' }, { sentAt: t }, { convertedAt: null }, 'Sent'],
    [{ status: 'arrived' }, { sentAt: t }, { convertedAt: t }, 'On Work Board'],
    [{ status: 'cancelled', cancelledAt: t }, { sentAt: t }, { convertedAt: t }, 'Cancelled'],
    [{ status: 'cancelled', cancelledAt: t }, { sentAt: null }, { convertedAt: null }, 'Cancelled'],
    [{ status: 'delivered' }, { sentAt: null }, { convertedAt: null }, 'Archived'],
  ] as const)('%o → %s', (order, intake, est, want) => expect(intakeStatus(order, intake, est)).toBe(want))
})
