import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { randomUUID } from 'node:crypto'
vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
vi.mock('@/apps/settings/db', () => ({ getBusinessConfig: async () => ({ defaultTaxBps: 825 }) }))
import { getDb } from '@/platform/db'
import { moveBoardOrderToEstimates } from './move-from-board'
const pg = new PGlite()
afterAll(() => pg.close())
beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE vehicles(id uuid PRIMARY KEY, year text, make text, model text, vin text);
    CREATE TABLE service_orders(id uuid PRIMARY KEY, vehicle_id uuid, customer_name text, status text,
      source text, service_type text, started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
      delivered_at timestamptz, arrived_at timestamptz, approved_price_cents int, updated_at timestamptz, services jsonb, notes text);
    CREATE TABLE service_order_assignments(service_order_id uuid);
    CREATE TABLE dealer_scans(service_order_id uuid);
    CREATE TABLE job_estimates(service_order_id uuid UNIQUE, status text DEFAULT 'draft', tax_rate_bps int,
      explicit_tax_category text, created_by text, updated_by text, decided_at timestamptz, converted_at timestamptz,
      updated_at timestamptz, qb_invoice_id text, qb_status text DEFAULT 'none', total_cents int);
    CREATE TABLE estimate_intakes(order_id uuid PRIMARY KEY, locked_at timestamptz);
    CREATE TABLE quick_entry_jobs(service_order_id uuid, vehicle_id uuid, customer_name text, year text, make text,
      model text, vin text, created_by text, customer_email text);
    CREATE TABLE service_order_events(service_order_id uuid, event_type text, employee_name text, old_status text, new_status text, note text);
  `)
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
async function fixture() {
  const id = randomUUID()
  await pg.query(`INSERT INTO vehicles(id, year, make, model) VALUES ($1, '2016', 'Ford', 'F-150')`, [id])
  await pg.query(`INSERT INTO service_orders(id, vehicle_id, customer_name, status, source, service_type, arrived_at, services, notes)
    VALUES ($1, $1, 'Test Customer', 'arrived', 'quick_entry', 'retail', now(), '["Interior Detail"]', 'Keep this note')`, [id])
  return id
}
it('moves the same job atomically, keeps existing contact and price, and retries without duplicate audit', async () => {
  const id = await fixture()
  await pg.query(`INSERT INTO job_estimates(service_order_id, total_cents, status) VALUES ($1, 12345, 'converted')`, [id])
  await pg.query(`INSERT INTO quick_entry_jobs(service_order_id, customer_email) VALUES ($1, 'test@example.com')`, [id])
  await moveBoardOrderToEstimates(id, 'Manager')
  await moveBoardOrderToEstimates(id, 'Manager')
  const { rows } = await pg.query(`SELECT so.status, so.arrived_at, so.services, so.notes, e.total_cents, e.status AS estimate_status,
    q.customer_email FROM service_orders so JOIN job_estimates e ON e.service_order_id = so.id
    JOIN quick_entry_jobs q ON q.service_order_id = so.id WHERE so.id = $1`, [id])
  expect(rows).toEqual([expect.objectContaining({ status: 'estimate', arrived_at: null, services: ['Interior Detail'],
    notes: 'Keep this note', total_cents: 12345, estimate_status: 'draft', customer_email: 'test@example.com' })])
  expect((await pg.query(`SELECT * FROM service_order_events WHERE service_order_id = $1`, [id])).rows).toHaveLength(1)
})
it('creates missing intake, contact and estimate together', async () => {
  const id = await fixture()
  await moveBoardOrderToEstimates(id, 'Manager')
  expect((await pg.query(`SELECT * FROM estimate_intakes i JOIN job_estimates e ON e.service_order_id=i.order_id
    JOIN quick_entry_jobs q ON q.service_order_id=i.order_id WHERE i.order_id=$1`, [id])).rows).toHaveLength(1)
})
for (const [label, change] of [
  ['started', `UPDATE service_orders SET started_at=now() WHERE id=$1`],
  ['completed', `UPDATE service_orders SET completed_at=now() WHERE id=$1`],
  ['dealer', `UPDATE service_orders SET source='dealer_checkin' WHERE id=$1`],
  ['assigned', `INSERT INTO service_order_assignments VALUES ($1)`],
  ['invoiced', `INSERT INTO job_estimates(service_order_id, qb_invoice_id) VALUES ($1, 'QB1')`],
  ['invoice in flight', `INSERT INTO job_estimates(service_order_id, qb_status) VALUES ($1, 'creating')`],
  ['locked', `INSERT INTO estimate_intakes VALUES ($1, now())`],
]) {
  it(`leaves ${label} jobs untouched`, async () => {
    const id = await fixture()
    await pg.query(change, [id])
    await expect(moveBoardOrderToEstimates(id, 'Manager')).rejects.toThrow('Only retail jobs')
    expect((await pg.query(`SELECT status FROM service_orders WHERE id=$1`, [id])).rows).toEqual([{ status: 'arrived' }])
    expect((await pg.query(`SELECT * FROM service_order_events WHERE service_order_id=$1`, [id])).rows).toHaveLength(0)
  })
}
