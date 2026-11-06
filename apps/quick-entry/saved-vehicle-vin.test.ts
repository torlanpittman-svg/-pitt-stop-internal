/**
 * REGRESSION (PS-HJY66R, 2026-11-06): a returning customer's SAVED vehicle, reused at appointment check-in
 * (createQuickEntryJob({ vehicleId })), must keep its VIN on the Job — on the order's vehicle row AND on
 * the intake record (quick_entry_jobs.vin / final_vin). A booking carries no VIN, so recording the typed
 * text there lost it (seen on PS-25BG56: vehicle VIN 1FTFW7L80TFA12752, intake record NULL).
 * A vehicle with no saved row gets NO VIN — one is never inferred from year/make/model.
 *
 * In-memory PGlite from the real Drizzle schema. No DB/QB/network.
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
import { quickEntryJobs, serviceOrders, vehicles } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
})

const VIN = '1FTFW7L80TFA12752'
const booked = { year: '2026', make: 'Ford', model: 'F-150' }   // what the customer typed when booking — no VIN

describe('createQuickEntryJob with a saved vehicle', () => {
  it('keeps the saved VIN on the order vehicle AND the intake record; no duplicate vehicle row', async () => {
    const [saved] = await db.insert(vehicles).values({ vin: VIN, year: '2026', make: 'Ford', model: 'F-150', color: 'Oxford White' }).returning()
    const res = await createQuickEntryJob({ customerName: 'Pat Returning', vehicle: booked, vehicleId: saved.id, lines: [], createdBy: 'Tony', audit: { idMethod: 'saved_vehicle' } })
    const [order] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, res.serviceOrderId))
    expect(order.vehicleId).toBe(saved.id)
    const [intake] = await db.select().from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, res.serviceOrderId))
    expect(intake).toMatchObject({ vehicleId: saved.id, vin: VIN, finalVin: VIN, year: '2026', make: 'Ford', model: 'F-150', color: 'Oxford White', idMethod: 'saved_vehicle' })
    expect(await db.select().from(vehicles)).toHaveLength(1)
  })

  it('the saved row describes the vehicle; typed text only fills its blanks and never overwrites the row', async () => {
    const [saved] = await db.insert(vehicles).values({ vin: VIN, year: '2026', make: 'Ford', model: 'F-150 Lightning', color: null }).returning()
    await createQuickEntryJob({ customerName: 'Pat Returning', vehicle: { ...booked, color: 'Red' }, vehicleId: saved.id, lines: [] })
    const [intake] = await db.select().from(quickEntryJobs)
    expect(intake).toMatchObject({ vin: VIN, model: 'F-150 Lightning', color: 'Red' })
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, saved.id))
    expect(row).toMatchObject({ vin: VIN, model: 'F-150 Lightning', color: null })
  })

  it('no saved vehicle: a new row is created exactly as typed, with NO VIN (never inferred)', async () => {
    const res = await createQuickEntryJob({ customerName: 'Charles New', vehicle: { year: '2025', make: 'GMC', model: 'Sierra HD' }, vehicleId: null, lines: [] })
    const [order] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, res.serviceOrderId))
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, order.vehicleId!))
    expect(row).toMatchObject({ vin: null, year: '2025', make: 'GMC', model: 'Sierra HD' })
    const [intake] = await db.select().from(quickEntryJobs)
    expect(intake).toMatchObject({ vin: null, finalVin: null })
  })
})
