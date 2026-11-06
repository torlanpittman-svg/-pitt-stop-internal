/**
 * Completing a SAVED vehicle from a New Estimate intake — against a REAL Postgres (PGlite) running the
 * actual Drizzle schema (FKs included), with db.batch run the way Neon runs it: one transaction,
 * statements in order, FKs checked per statement. Earlier mocked tests asserted SQL text and missed two
 * real failures this suite protects against:
 *   • the 'vehicle_corrected' audit row must come AFTER its service_orders parent (FK) — with the old
 *     ordering every incomplete-saved-vehicle save failed outright;
 *   • a correction committed between createIntake's read and its write must win, AND the intake snapshot
 *     (quick_entry_jobs) and the audit must describe the row as PERSISTED, not the stale pre-read.
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

import { CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { createIntake, intakeInput } from './db'
import { serviceOrders, serviceOrderEvents, estimateIntakes, quickEntryJobs, vehicles } from '@/drizzle/schema'

const pg = new PGlite()
let db: PgliteDatabase<typeof schema>
/** Runs once, just before the next batch — a correction committed between createIntake's read and its write. */
let beforeBatch: (() => Promise<void>) | null = null

type Built = { sql: string; params: unknown[] }
beforeAll(async () => {
  process.env.ESTIMATE_LAYER_ENABLED = 'true'
  db = drizzle(pg, { schema })
  // Faithful Neon db.batch stand-in (PGlite's driver has none): the exact { sql, params } of each
  // statement, SEQUENTIALLY in ONE real transaction — so FK checks per statement and all-or-nothing
  // rollback behave as in production. Raw db.execute statements build via getQuery(), builders via toSQL().
  Object.assign(db, { batch: async (items: unknown[]) => {
    const hook = beforeBatch
    beforeBatch = null
    if (hook) await hook()
    const built = items.map((it) => { const q = it as { getQuery?: () => Built; toSQL?: () => Built }; return q.getQuery ? q.getQuery() : q.toSQL!() })
    return pg.transaction(async (tx) => {
      const out: unknown[] = []
      for (const q of built) out.push(await tx.query(q.sql, (q.params ?? []) as unknown[]))
      return out
    })
  } })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  beforeBatch = null
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
})

const SAVED_ID = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const VIN = '1GT12SEG4GF221480'
const input = (over: Partial<ReturnType<typeof intakeInput.parse>> = {}) => intakeInput.parse({ requestId: crypto.randomUUID(), customerName: 'Brian Returning',
  year: '2019', make: 'GMC', model: 'Sierra', vehicleId: SAVED_ID, lines: [{ name: 'Headlight Restoration', priceCents: 15000 }], ...over })
const seedVehicle = (v: Partial<typeof vehicles.$inferInsert>) => db.insert(vehicles).values({ id: SAVED_ID, vin: VIN, ...v })

const vehicleRow = async () => (await db.select().from(vehicles).where(eq(vehicles.id, SAVED_ID)))[0]
const snapshotRow = async (orderId: string) => (await db.select().from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, orderId)))[0]
const corrections = async (orderId: string) =>
  (await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId)))
    .filter((e) => e.eventType === 'vehicle_corrected').map((e) => JSON.parse(e.note ?? 'null'))

describe('createIntake with a saved vehicle that needs completing', () => {
  it('saved make/model but no year: the save SUCCEEDS (audit after its parent), keeps the vehicle id and VIN, fills the row, snapshots and audits it', async () => {
    await seedVehicle({ year: null, make: 'GMC', model: 'Sierra' })
    const id = await createIntake(input({ make: 'Chevrolet', model: 'Silverado' }), 'Manager')   // typed make/model must NOT replace what is on file

    expect(await db.select().from(vehicles)).toHaveLength(1)                        // no duplicate vehicle
    expect(await vehicleRow()).toMatchObject({ year: '2019', make: 'GMC', model: 'Sierra', vin: VIN })
    expect((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0]).toMatchObject({ vehicleId: SAVED_ID, status: 'estimate' })
    expect(await snapshotRow(id)).toMatchObject({ vehicleId: SAVED_ID, year: '2019', make: 'GMC', model: 'Sierra', vin: VIN, customerName: 'Brian Returning', createdBy: 'Manager' })
    expect(await corrections(id)).toEqual([expect.objectContaining({ changed: ['year'], old: { year: null }, new: { year: '2019' }, reason: 'estimate_intake_completed_saved_vehicle', qb: 'not_linked' })])
    expect((await db.select().from(estimateIntakes).where(eq(estimateIntakes.orderId, id)))).toHaveLength(1)
  })

  it('missing make and model: both are filled and audited together, the valid saved year is kept', async () => {
    await seedVehicle({ year: '2016', make: null, model: '' })
    const id = await createIntake(input({ year: '2019', make: 'GMC', model: 'Sierra' }), 'Manager')
    expect(await vehicleRow()).toMatchObject({ year: '2016', make: 'GMC', model: 'Sierra', vin: VIN })
    expect(await snapshotRow(id)).toMatchObject({ year: '2016', make: 'GMC', model: 'Sierra', vin: VIN })
    expect(await corrections(id)).toEqual([expect.objectContaining({ changed: ['make', 'model'], old: { make: null, model: '' }, new: { make: 'GMC', model: 'Sierra' } })])
  })

  it('a nonempty invalid saved year is corrected, not kept', async () => {
    await seedVehicle({ year: '19', make: 'GMC', model: 'Sierra', vin: null })
    const id = await createIntake(input(), 'Manager')
    expect(await vehicleRow()).toMatchObject({ year: '2019', vin: null })
    expect(await snapshotRow(id)).toMatchObject({ year: '2019', vin: null })
    expect(await corrections(id)).toEqual([expect.objectContaining({ changed: ['year'], old: { year: '19' }, new: { year: '2019' } })])
  })

  it('a complete saved vehicle gets no write and no audit event, and the intake records what is on file', async () => {
    await seedVehicle({ year: '2016', make: 'GMC', model: 'Sierra' })
    const id = await createIntake(input({ year: '2019', make: 'Ford', model: 'F-150' }), 'Manager')
    expect(await vehicleRow()).toMatchObject({ year: '2016', make: 'GMC', model: 'Sierra', vin: VIN })
    expect(await snapshotRow(id)).toMatchObject({ year: '2016', make: 'GMC', model: 'Sierra', vin: VIN })
    expect(await corrections(id)).toEqual([])
  })

  it('a correction committed between the read and the write WINS, the snapshot matches the persisted row, and the audit never claims the skipped fill', async () => {
    await seedVehicle({ year: null, make: null, model: 'Sierra' })
    // Between createIntake's read (make missing) and its write, a manager corrects the make.
    beforeBatch = async () => { await db.update(vehicles).set({ make: 'Chevrolet' }).where(eq(vehicles.id, SAVED_ID)) }
    const id = await createIntake(input({ year: '2019', make: 'GMC', model: 'Sierra' }), 'Manager')

    expect(await vehicleRow()).toMatchObject({ year: '2019', make: 'Chevrolet', model: 'Sierra' })   // correction preserved, year still filled
    expect(await snapshotRow(id)).toMatchObject({ year: '2019', make: 'Chevrolet', model: 'Sierra' }) // snapshot = the row as persisted, not the stale read
    expect(await corrections(id)).toEqual([expect.objectContaining({ changed: ['year'], old: { year: null }, new: { year: '2019' } })])   // make fill was skipped → never audited
  })

  it('when the intervening correction completes EVERYTHING, nothing is overwritten and no audit event is written at all', async () => {
    await seedVehicle({ year: null, make: 'GMC', model: 'Sierra' })
    beforeBatch = async () => { await db.update(vehicles).set({ year: '2021' }).where(eq(vehicles.id, SAVED_ID)) }
    const id = await createIntake(input({ year: '2019' }), 'Manager')
    expect(await vehicleRow()).toMatchObject({ year: '2021', make: 'GMC', model: 'Sierra' })
    expect(await snapshotRow(id)).toMatchObject({ year: '2021', make: 'GMC', model: 'Sierra' })
    expect(await corrections(id)).toEqual([])
  })

  it('a failure later in the batch rolls EVERYTHING back — no order, no snapshot, no intake, and the vehicle fill is undone', async () => {
    await seedVehicle({ year: null, make: 'GMC', model: 'Sierra' })
    await db.execute(`ALTER TABLE job_services RENAME TO job_services_hidden`)   // breaks a statement AFTER the vehicle fill
    try {
      await expect(createIntake(input(), 'Manager')).rejects.toThrow()
    } finally {
      await db.execute(`ALTER TABLE job_services_hidden RENAME TO job_services`)
    }
    expect(await vehicleRow()).toMatchObject({ year: null, make: 'GMC', model: 'Sierra' })   // fill rolled back
    expect(await db.select().from(serviceOrders)).toHaveLength(0)
    expect(await db.select().from(quickEntryJobs)).toHaveLength(0)
    expect(await db.select().from(estimateIntakes)).toHaveLength(0)
    expect(await db.select().from(serviceOrderEvents)).toHaveLength(0)
  })

  it('the same requestId retried sequentially short-circuits: no duplicate rows, no extra audit', async () => {
    await seedVehicle({ year: null, make: 'GMC', model: 'Sierra' })
    const intake = input()
    const id = await createIntake(intake, 'Manager')
    expect(await createIntake(intake, 'Manager')).toBe(id)
    expect(await db.select().from(serviceOrders)).toHaveLength(1)
    expect(await db.select().from(quickEntryJobs)).toHaveLength(1)
    expect(await db.select().from(estimateIntakes)).toHaveLength(1)
    expect(await corrections(id)).toHaveLength(1)
  })

  it('a replayed requestId that already passed the existence check (double-tap race) resolves to the winner — no duplicate rows, no extra audit', async () => {
    await seedVehicle({ year: null, make: 'GMC', model: 'Sierra' })
    const intake = input()
    // The competing identical request commits first, AFTER this call's existence check already passed.
    beforeBatch = async () => { await createIntake(intake, 'Manager') }
    const id = await createIntake(intake, 'Manager')   // its own batch hits the PK conflict → rolls back → resolves to the committed intake
    expect(id).toBe(intake.requestId)
    expect(await db.select().from(serviceOrders)).toHaveLength(1)
    expect(await db.select().from(quickEntryJobs)).toHaveLength(1)
    expect(await db.select().from(estimateIntakes)).toHaveLength(1)
    expect(await vehicleRow()).toMatchObject({ year: '2019' })
    expect(await corrections(id)).toHaveLength(1)
  })
})
