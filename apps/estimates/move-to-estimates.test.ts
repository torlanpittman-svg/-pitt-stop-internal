import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { randomUUID } from 'node:crypto'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
vi.mock('@/apps/settings/db', () => ({ getBusinessConfig: async () => ({ defaultTaxBps: 825 }) }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
// Move to Estimates is a PURE status move — it must never touch QuickBooks. We mock the QB module so
// that if any code path ever reached it, the test would still run, and we assert it is NOT called.
const voidInvoice = vi.hoisted(() => vi.fn())
vi.mock('@/apps/quickbooks/invoice-removal', () => ({ voidInvoice, readRetailInvoiceSnapshot: vi.fn() }))

import { getDb } from '@/platform/db'
import { moveIntakeToBoard } from './db'
import { executeMoveToEstimates, planMoveToEstimates, moveBaseEligibility } from './move-to-estimates'

const pg = new PGlite()
afterAll(() => pg.close())

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE vehicles(id uuid PRIMARY KEY, year text, make text, model text, color text, vin text);
    CREATE TABLE service_orders(id uuid PRIMARY KEY, vehicle_id uuid, customer_name text, status text,
      source text, service_type text, started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
      delivered_at timestamptz, arrived_at timestamptz, quoted_price_cents int, approved_price_cents int,
      updated_at timestamptz, services jsonb, notes text);
    CREATE TABLE service_order_assignments(service_order_id uuid);
    CREATE TABLE dealer_scans(service_order_id uuid);
    CREATE TABLE job_estimates(id uuid DEFAULT gen_random_uuid(), service_order_id uuid UNIQUE, status text DEFAULT 'draft',
      tax_rate_bps int, explicit_tax_category text, created_by text, updated_by text, decided_at timestamptz,
      converted_at timestamptz, updated_at timestamptz, qb_invoice_id text, qb_invoice_number text,
      qb_status text DEFAULT 'none', qb_sync_token text, qb_sent_at timestamptz, total_cents int);
    CREATE TABLE job_services(id uuid DEFAULT gen_random_uuid(), job_estimate_id uuid, title text,
      source text DEFAULT 'manual', sort_order int DEFAULT 0, approval_state text DEFAULT 'pending',
      created_at timestamptz DEFAULT now(), updated_at timestamptz);
    CREATE TABLE estimate_intakes(order_id uuid PRIMARY KEY, locked_at timestamptz);
    CREATE TABLE quick_entry_jobs(service_order_id uuid, vehicle_id uuid, customer_name text, year text, make text,
      model text, vin text, created_by text, customer_email text);
    CREATE TABLE service_order_events(service_order_id uuid, event_type text, employee_name text, old_status text, new_status text, note text);
  `)
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})

beforeEach(async () => {
  voidInvoice.mockReset()
  await pg.exec(`TRUNCATE vehicles, service_orders, service_order_assignments, dealer_scans, job_estimates,
    job_services, estimate_intakes, quick_entry_jobs, service_order_events`)
})

/** A retail job on the Work Board (arrived, not started), with a contact snapshot and a priced draft
 *  estimate carrying one real service — optionally already carrying a QuickBooks invoice link. */
async function fixture(opts: { estimate?: Partial<Record<string, unknown>> } = {}) {
  const id = randomUUID()
  await pg.query(`INSERT INTO vehicles(id, year, make, model, vin) VALUES ($1,'2017','Volkswagen','Golf','3VW217AU8HM056855')`, [id])
  await pg.query(`INSERT INTO service_orders(id, vehicle_id, customer_name, status, source, service_type, arrived_at, approved_price_cents, services, notes)
    VALUES ($1,$1,'Author Molina','arrived','quick_entry','retail', now(), 324000, '["Interior Detail"]', 'Keep this note')`, [id])
  const e = { qb_invoice_id: null, qb_invoice_number: null, qb_status: 'none', qb_sent_at: null, total_cents: 335677, ...(opts.estimate ?? {}) }
  const est = (await pg.query<{ id: string }>(
    `INSERT INTO job_estimates(service_order_id, status, total_cents, qb_invoice_id, qb_invoice_number, qb_status, qb_sent_at)
     VALUES ($1,'draft',$2,$3,$4,$5,$6) RETURNING id`,
    [id, e.total_cents, e.qb_invoice_id, e.qb_invoice_number, e.qb_status, e.qb_sent_at])).rows[0]
  await pg.query(`INSERT INTO job_services(job_estimate_id, title, source) VALUES ($1,'Interior Detail','manual')`, [est.id])
  await pg.query(`INSERT INTO quick_entry_jobs(service_order_id, customer_email) VALUES ($1,'amolina@example.com')`, [id])
  return { id, estimateId: est.id }
}

async function status(id: string) {
  return (await pg.query<{ status: string }>(`SELECT status FROM service_orders WHERE id=$1`, [id])).rows[0]?.status
}
async function events(id: string, type: string) {
  return (await pg.query(`SELECT * FROM service_order_events WHERE service_order_id=$1 AND event_type=$2`, [id, type])).rows
}

it('moves the same job, preserving all detail, and is idempotent on a repeat click', async () => {
  const { id } = await fixture()
  const r1 = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  const r2 = await executeMoveToEstimates({ orderId: id, actor: 'Manager' }) // repeated click / double-submit
  expect(r1).toMatchObject({ ok: true })
  expect(r2).toMatchObject({ ok: true, alreadyMoved: true })
  const { rows } = await pg.query(`SELECT so.status, so.arrived_at, so.services, so.notes, v.vin, e.status AS est, e.total_cents, q.customer_email
    FROM service_orders so JOIN vehicles v ON v.id=so.vehicle_id JOIN job_estimates e ON e.service_order_id=so.id
    JOIN quick_entry_jobs q ON q.service_order_id=so.id WHERE so.id=$1`, [id])
  expect(rows[0]).toMatchObject({ status: 'estimate', arrived_at: null, services: ['Interior Detail'], notes: 'Keep this note',
    vin: '3VW217AU8HM056855', est: 'draft', total_cents: 335677, customer_email: 'amolina@example.com' })
  expect(await events(id, 'moved_to_estimates')).toHaveLength(1) // no duplicate audit on the second click
  const [intake] = (await pg.query(`SELECT count(*)::int n FROM estimate_intakes WHERE order_id=$1`, [id])).rows as any[]
  expect(intake.n).toBe(1) // now appears on the Estimates board
})

it('moves a job that ALREADY has a QuickBooks invoice, leaving the invoice untouched and linked', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: '24167', qb_invoice_number: '100897', qb_status: 'created' } })
  const r = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  expect(r).toMatchObject({ ok: true })
  expect(voidInvoice).not.toHaveBeenCalled()         // QuickBooks is never touched
  expect(await status(id)).toBe('estimate')
  const [est] = (await pg.query(`SELECT qb_invoice_id, qb_invoice_number, qb_status FROM job_estimates WHERE service_order_id=$1`, [id])).rows as any[]
  expect(est).toMatchObject({ qb_invoice_id: '24167', qb_invoice_number: '100897', qb_status: 'created' }) // link unchanged
})

it('preview is eligible even with an invoice, and never mentions voiding', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: '24167', qb_invoice_number: '100897', qb_status: 'created' } })
  const { preview } = await planMoveToEstimates(id)
  expect(preview).toEqual({ eligible: true, customer: 'Author Molina', vehicle: '2017 Volkswagen Golf' })
  expect(JSON.stringify(preview)).not.toMatch(/void|invoice/i)
})

const baseBlocks: [string, string, string, string][] = [
  ['started', `UPDATE service_orders SET started_at=now() WHERE id=$1`, 'started', 'already started'],
  ['completed', `UPDATE service_orders SET completed_at=now() WHERE id=$1`, 'completed', 'already finished'],
  ['dealer', `UPDATE service_orders SET source='dealer_checkin' WHERE id=$1`, 'dealer', 'Dealer'],
  ['assigned', `INSERT INTO service_order_assignments VALUES ($1)`, 'assigned', 'technician is assigned'],
]
for (const [label, change, code, phrase] of baseBlocks) {
  it(`gives a specific reason and does not move a ${label} job`, async () => {
    const { id } = await fixture()
    await pg.query(change, [id])
    const r = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(code)
    expect(r.error).toContain(phrase)
    expect(await status(id)).toBe('arrived')
    const p = await planMoveToEstimates(id)
    expect(p.preview).toMatchObject({ eligible: false, code })
  })
}

it('completes the round trip: the SAME record returns to the Work Board via the approval path', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: '24167', qb_invoice_number: '100897', qb_status: 'created' } })
  await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  expect(await status(id)).toBe('estimate')
  await moveIntakeToBoard(id, 'Manager')
  const [row] = (await pg.query(`SELECT status, approved_price_cents FROM service_orders WHERE id=$1`, [id])).rows as any[]
  expect(row).toMatchObject({ status: 'arrived', approved_price_cents: 335677 })
  // Invoice link still intact after the full round trip.
  expect((await pg.query(`SELECT qb_invoice_number FROM job_estimates WHERE service_order_id=$1`, [id])).rows[0]).toMatchObject({ qb_invoice_number: '100897' })
})

it('moveBaseEligibility is a pure gate with specific reasons (invoice is not a gate)', () => {
  const base = { id: 'x', status: 'arrived', source: 'quick_entry', serviceType: 'retail', customerName: 'A',
    startedAt: null, completedAt: null, cancelledAt: null, deliveredAt: null, vehicle: 'v', assignmentCount: 0 }
  expect(moveBaseEligibility(base as any)).toEqual({ ok: true })
  expect(moveBaseEligibility({ ...base, serviceType: 'dealer_in' } as any)).toMatchObject({ ok: false, code: 'dealer' })
  expect(moveBaseEligibility({ ...base, status: 'in_progress' } as any)).toMatchObject({ ok: false, code: 'not_waiting' })
})
