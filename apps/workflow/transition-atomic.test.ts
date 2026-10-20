/**
 * transitionOrder is atomic: the status/completion write, the technician-timer shutdown, and the audit
 * events apply together or not at all. Previously they were separate writes — a failure after the status
 * update left a Job Ready with a running timer / missing history, and the already-Ready retry then
 * reported success without repairing it. Failure is injected with a real Postgres trigger that makes the
 * audit insert fail AFTER the status-update step of the same statement. In-memory PGlite, real schema.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

import { transitionOrder } from './db'
import { serviceOrders, vehicles, serviceOrderEvents, serviceOrderAssignments } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
  // Fault injection: while fail_events has a row matching the event type, inserting that event raises.
  await db.execute(`CREATE TABLE fail_events (event_type text PRIMARY KEY)`)
  await db.execute(`CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF EXISTS (SELECT 1 FROM fail_events WHERE event_type = NEW.event_type) THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`)
  await db.execute(`CREATE TRIGGER fail_event BEFORE INSERT ON service_order_events FOR EACH ROW EXECUTE FUNCTION fail_event()`)
})
beforeEach(async () => {
  for (const t of ['fail_events', 'service_order_assignments', 'service_order_events', 'service_orders', 'vehicles']) await db.execute(`DELETE FROM ${t}`)
})

async function workingJob(status = 'in_progress') {
  const [v] = await db.insert(vehicles).values({ make: 'Jeep', model: 'Wrangler', year: '2015' }).returning()
  const [o] = await db.insert(serviceOrders).values({
    orderNumber: `AT-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status, customerName: 'Test', services: ['Interior detail'],
    startedAt: new Date('2026-10-20T13:00:00Z'),
  }).returning()
  await db.insert(serviceOrderAssignments).values({ serviceOrderId: o.id, employeeName: 'Tony', startedAt: new Date('2026-10-20T13:00:00Z') })
  return o.id
}
const finish = (orderId: string, by = 'Tony') =>
  transitionOrder({ orderId, newStatus: 'ready', employeeName: by, completedBy: by, completionChecklist: { allWorkComplete: true, by } })
const state = async (orderId: string) => {
  const [o] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, orderId))
  const evs = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, orderId))
  const timers = await db.select().from(serviceOrderAssignments).where(eq(serviceOrderAssignments.serviceOrderId, orderId))
  return {
    status: o.status, completedAt: o.completedAt, completedBy: o.completedBy, checklist: o.completionChecklist,
    running: timers.filter((t) => t.stoppedAt == null).length,
    completed: evs.filter((e) => e.eventType === 'completed').length,
    statusChanged: evs.filter((e) => e.eventType === 'status_changed').length,
  }
}

describe('Finish Job is all-or-nothing', () => {
  it('a failure after the status-write step leaves NOTHING applied; the retry completes exactly once', async () => {
    const id = await workingJob()
    await db.execute(`INSERT INTO fail_events VALUES ('completed')`)
    await expect(finish(id)).rejects.toThrow()
    expect(await state(id)).toMatchObject({ status: 'in_progress', completedAt: null, completedBy: null, checklist: null, running: 1, completed: 0, statusChanged: 0 })

    await db.execute(`DELETE FROM fail_events`)
    const r = await finish(id)
    expect(r.ok).toBe(true)
    const s = await state(id)
    expect(s).toMatchObject({ status: 'ready', completedBy: 'Tony', running: 0, completed: 1, statusChanged: 1 })
    expect(s.completedAt).not.toBeNull()
    expect(s.checklist).toMatchObject({ allWorkComplete: true })

    // A further retry is the same answer: no new events, date and attribution unchanged.
    const again = await finish(id, 'Darryl')
    expect(again.ok).toBe(true)
    expect(await state(id)).toEqual(s)
  })

  it('the same holds when the status_changed audit insert fails', async () => {
    const id = await workingJob()
    await db.execute(`INSERT INTO fail_events VALUES ('status_changed')`)
    await expect(finish(id)).rejects.toThrow()
    expect(await state(id)).toMatchObject({ status: 'in_progress', completedAt: null, running: 1, completed: 0, statusChanged: 0 })
  })

  it('concurrent submits: exactly one completion, no running timer, full history once', async () => {
    const id = await workingJob()
    const results = await Promise.all([finish(id, 'Tony'), finish(id, 'Darryl'), finish(id, 'Torlan')])
    expect(results.every((r) => r.ok)).toBe(true)
    const s = await state(id)
    expect(s).toMatchObject({ status: 'ready', running: 0, completed: 1, statusChanged: 1 })
    expect(['Tony', 'Darryl', 'Torlan']).toContain(s.completedBy)
    expect(results.every((r) => r.order!.completedBy === s.completedBy)).toBe(true)
  })

  it('repairs a completion an older non-atomic write left half-done (timer running, no completed event), idempotently', async () => {
    const id = await workingJob()
    const stamped = new Date('2026-10-20T15:00:00Z')
    await db.update(serviceOrders).set({ status: 'ready', completedAt: stamped, completedBy: 'Tony' }).where(eq(serviceOrders.id, id))
    for (let i = 0; i < 2; i++) expect((await finish(id, 'Darryl')).ok).toBe(true)
    const s = await state(id)
    expect(s).toMatchObject({ status: 'ready', completedBy: 'Tony', running: 0, completed: 1 })
    expect(s.completedAt).toEqual(stamped)
    const [ev] = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.eventType, 'completed'))
    expect(ev.note).toMatch(/recovered/)
    expect(ev.employeeName).toBe('Tony')
  })
})

describe('other transitions keep their behaviour (shared function)', () => {
  it('arrived → in_progress stamps started_at once and keeps the running timer', async () => {
    const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2020' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: `AT-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived', customerName: 'T' }).returning()
    await db.insert(serviceOrderAssignments).values({ serviceOrderId: o.id, employeeName: 'Tony', startedAt: new Date() })
    const r = await transitionOrder({ orderId: o.id, newStatus: 'in_progress', employeeName: 'Tony' })
    expect(r.ok).toBe(true)
    expect(r.order!.startedAt).not.toBeNull()
    expect((await state(o.id))).toMatchObject({ status: 'in_progress', running: 1, statusChanged: 1, completed: 0 })
  })

  it('pause stops timers; ready → delivered keeps completed_at; invalid moves are refused and change nothing', async () => {
    const id = await workingJob()
    expect((await transitionOrder({ orderId: id, newStatus: 'paused', employeeName: 'Tony' })).ok).toBe(true)
    expect((await state(id)).running).toBe(0)
    expect((await transitionOrder({ orderId: id, newStatus: 'in_progress', employeeName: 'Tony' })).ok).toBe(true)
    expect((await finish(id)).ok).toBe(true)
    const done = await state(id)
    const d = await transitionOrder({ orderId: id, newStatus: 'delivered', employeeName: 'Tony' })
    expect(d.ok).toBe(true)
    expect(d.order!.deliveredAt).not.toBeNull()
    expect(d.order!.completedAt).toEqual(done.completedAt)
    const bad = await transitionOrder({ orderId: id, newStatus: 'in_progress', employeeName: 'Tony' })
    expect(bad.ok).toBe(false)
    expect((await state(id)).status).toBe('delivered')
  })
})
