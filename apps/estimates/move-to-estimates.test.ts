import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { randomUUID } from 'node:crypto'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
vi.mock('@/apps/settings/db', () => ({ getBusinessConfig: async () => ({ defaultTaxBps: 825 }) }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
// The QuickBooks reads/writes are the only real side effects — mock them so the fail-closed brain is
// exercised without a live QBO. Each test sets the return values it needs.
const { readRetailInvoiceSnapshot, voidInvoice } = vi.hoisted(() => ({ readRetailInvoiceSnapshot: vi.fn(), voidInvoice: vi.fn() }))
vi.mock('@/apps/quickbooks/invoice-removal', () => ({ readRetailInvoiceSnapshot, voidInvoice }))

import { getDb } from '@/platform/db'
import { moveIntakeToBoard } from './db'
import { executeMoveToEstimates, planMoveToEstimates, moveBaseEligibility } from './move-to-estimates'
import type { QbInvoiceSnapshot } from '@/apps/workflow/removal-plan'

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
  readRetailInvoiceSnapshot.mockReset()
  voidInvoice.mockReset()
  await pg.exec(`TRUNCATE vehicles, service_orders, service_order_assignments, dealer_scans, job_estimates,
    job_services, estimate_intakes, quick_entry_jobs, service_order_events`)
})

/** A clean retail job sitting on the Work Board (arrived, not started), with a contact snapshot and a
 *  priced draft estimate carrying one real service — the shape "Move to Estimates" is built for. */
async function fixture(opts: { estimate?: Partial<Record<string, unknown>> } = {}) {
  const id = randomUUID()
  await pg.query(`INSERT INTO vehicles(id, year, make, model) VALUES ($1,'2017','Volkswagen','Golf')`, [id])
  await pg.query(`INSERT INTO service_orders(id, vehicle_id, customer_name, status, source, service_type, arrived_at, services, notes)
    VALUES ($1,$1,'Author Molina','arrived','quick_entry','retail', now(), '["Interior Detail"]', 'Keep this note')`, [id])
  const e = { qb_invoice_id: null, qb_invoice_number: null, qb_status: 'none', qb_sent_at: null, total_cents: 335677, ...(opts.estimate ?? {}) }
  const est = (await pg.query<{ id: string }>(
    `INSERT INTO job_estimates(service_order_id, status, total_cents, qb_invoice_id, qb_invoice_number, qb_status, qb_sent_at)
     VALUES ($1,'draft',$2,$3,$4,$5,$6) RETURNING id`,
    [id, e.total_cents, e.qb_invoice_id, e.qb_invoice_number, e.qb_status, e.qb_sent_at])).rows[0]
  await pg.query(`INSERT INTO job_services(job_estimate_id, title, source) VALUES ($1,'Interior Detail','manual')`, [est.id])
  await pg.query(`INSERT INTO quick_entry_jobs(service_order_id, customer_email) VALUES ($1,'amolina@example.com')`, [id])
  return { id, estimateId: est.id }
}

function snapshot(over: Partial<QbInvoiceSnapshot> = {}): QbInvoiceSnapshot {
  return { status: 'resolved', invoiceId: 'QB1', invoiceNumber: '100897', totalCents: 335677, balanceCents: 335677,
    emailStatus: 'NotSet', voided: false, salesLines: [{ id: '1', description: 'Interior Detail', amountCents: 335677 }], ...over }
}

async function status(id: string) {
  return (await pg.query<{ status: string }>(`SELECT status FROM service_orders WHERE id=$1`, [id])).rows[0]?.status
}
async function events(id: string, type: string) {
  return (await pg.query(`SELECT * FROM service_order_events WHERE service_order_id=$1 AND event_type=$2`, [id, type])).rows
}

it('moves an un-invoiced job, preserving the same record, and is idempotent on a repeat click', async () => {
  const { id } = await fixture()
  const r1 = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  const r2 = await executeMoveToEstimates({ orderId: id, actor: 'Manager' }) // repeated click / double-submit
  expect(r1).toMatchObject({ ok: true, qbAction: 'none' })
  expect(r2).toMatchObject({ ok: true, alreadyMoved: true })
  expect(voidInvoice).not.toHaveBeenCalled()
  const { rows } = await pg.query(`SELECT so.status, so.arrived_at, so.services, so.notes, e.status AS est, q.customer_email
    FROM service_orders so JOIN job_estimates e ON e.service_order_id=so.id JOIN quick_entry_jobs q ON q.service_order_id=so.id WHERE so.id=$1`, [id])
  expect(rows[0]).toMatchObject({ status: 'estimate', arrived_at: null, services: ['Interior Detail'], notes: 'Keep this note', est: 'draft', customer_email: 'amolina@example.com' })
  expect(await events(id, 'moved_to_estimates')).toHaveLength(1) // no duplicate audit on the second click
})

it('auto-voids a clean, unsent standalone invoice, clears the dead link, then moves', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: 'QB1', qb_invoice_number: '100897', qb_status: 'created' } })
  readRetailInvoiceSnapshot.mockResolvedValue(snapshot())
  voidInvoice.mockResolvedValue({ ok: true, invoiceId: 'QB1', invoiceNumber: '100897', totalCentsBefore: 335677, totalCentsAfter: 0 })
  const r = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  expect(r).toMatchObject({ ok: true, qbAction: 'invoice_voided', invoiceNumber: '100897' })
  expect(voidInvoice).toHaveBeenCalledWith({ invoiceId: 'QB1' })
  expect(await status(id)).toBe('estimate')
  const [est] = (await pg.query(`SELECT qb_invoice_id, qb_status FROM job_estimates WHERE service_order_id=$1`, [id])).rows as any[]
  expect(est).toMatchObject({ qb_invoice_id: null, qb_status: 'none' })
  expect(await events(id, 'move_qb_invoice_voided')).toHaveLength(1)
})

it('recovers a crash between void and move without voiding twice', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: 'QB1', qb_invoice_number: '100897', qb_status: 'created' } })
  // Simulate a prior attempt that voided QB but died before the move landed.
  await pg.query(`INSERT INTO service_order_events(service_order_id, event_type) VALUES ($1,'move_qb_invoice_voided')`, [id])
  const r = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  expect(r).toMatchObject({ ok: true, qbAction: 'already_done' })
  expect(voidInvoice).not.toHaveBeenCalled()
  expect(readRetailInvoiceSnapshot).not.toHaveBeenCalled()
  expect(await status(id)).toBe('estimate')
})

const blocked: [string, Partial<QbInvoiceSnapshot>, string, string][] = [
  ['payment activity', { balanceCents: 100 }, 'invoice_paid', 'payment activity'],
  ['sent to the customer', { emailStatus: 'EmailSent' }, 'invoice_sent', 'sent to the customer'],
  ['ambiguous identity', { status: 'ambiguous', ambiguousReason: 'psid_mismatch' }, 'invoice_ambiguous', 'exact QuickBooks invoice'],
]
for (const [label, over, code, phrase] of blocked) {
  it(`refuses an invoiced job and leaves QuickBooks + the board untouched: ${label}`, async () => {
    const { id } = await fixture({ estimate: { qb_invoice_id: 'QB1', qb_invoice_number: '100897', qb_status: 'created' } })
    readRetailInvoiceSnapshot.mockResolvedValue(snapshot(over))
    const r = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(code)
    expect(r.error).toContain(phrase)
    expect(voidInvoice).not.toHaveBeenCalled()
    expect(await status(id)).toBe('arrived')            // stays on the Work Board
    expect(await events(id, 'moved_to_estimates')).toHaveLength(0)
  })
}

it('fails closed (no move, no clear) when QuickBooks is unreachable', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: 'QB1', qb_invoice_number: '100897', qb_status: 'created' } })
  readRetailInvoiceSnapshot.mockRejectedValue(new Error('network'))
  const r = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  expect(r).toMatchObject({ ok: false, block: 'qb_unreachable' })
  expect(await status(id)).toBe('arrived')
  expect((await pg.query(`SELECT qb_invoice_id FROM job_estimates WHERE service_order_id=$1`, [id])).rows[0]).toMatchObject({ qb_invoice_id: 'QB1' })
})

it('fails closed when the QuickBooks void itself fails', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: 'QB1', qb_invoice_number: '100897', qb_status: 'created' } })
  readRetailInvoiceSnapshot.mockResolvedValue(snapshot())
  voidInvoice.mockResolvedValue({ ok: false, error: 'boom' })
  const r = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  expect(r).toMatchObject({ ok: false, block: 'qb_write_failed' })
  expect(await status(id)).toBe('arrived')
  expect((await pg.query(`SELECT qb_invoice_id FROM job_estimates WHERE service_order_id=$1`, [id])).rows[0]).toMatchObject({ qb_invoice_id: 'QB1' })
})

const baseBlocks: [string, string, string][] = [
  ['started', `UPDATE service_orders SET started_at=now() WHERE id=$1`, 'started'],
  ['completed', `UPDATE service_orders SET completed_at=now() WHERE id=$1`, 'completed'],
  ['dealer', `UPDATE service_orders SET source='dealer_checkin' WHERE id=$1`, 'dealer'],
  ['assigned', `INSERT INTO service_order_assignments VALUES ($1)`, 'assigned'],
]
for (const [label, change, code] of baseBlocks) {
  it(`gives a specific reason and does not move a ${label} job`, async () => {
    const { id } = await fixture()
    await pg.query(change, [id])
    const r = await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(code)
    expect(await status(id)).toBe('arrived')
    expect(voidInvoice).not.toHaveBeenCalled()
  })
}

it('preview shows customer, vehicle, and the specific blocked reason without mutating anything', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: 'QB1', qb_invoice_number: '100897', qb_status: 'created' } })
  readRetailInvoiceSnapshot.mockResolvedValue(snapshot())
  const ok = await planMoveToEstimates(id)
  expect(ok.preview).toMatchObject({ eligible: true, willVoidInvoice: true, invoiceNumber: '100897', customer: 'Author Molina', vehicle: '2017 Volkswagen Golf' })

  await pg.query(`UPDATE service_orders SET started_at=now() WHERE id=$1`, [id])
  const blocked = await planMoveToEstimates(id)
  expect(blocked.preview).toMatchObject({ eligible: false, code: 'started' })
  expect(blocked.preview?.reason).toContain('already started')
  expect(voidInvoice).not.toHaveBeenCalled()
})

it('completes the round trip: the SAME record returns to the Work Board via the approval path', async () => {
  const { id } = await fixture()
  await executeMoveToEstimates({ orderId: id, actor: 'Manager' })
  expect(await status(id)).toBe('estimate')
  // Existing approval workflow brings the very same order back to the board (priced, with a service).
  await moveIntakeToBoard(id, 'Manager')
  const [row] = (await pg.query(`SELECT status, approved_price_cents FROM service_orders WHERE id=$1`, [id])).rows as any[]
  expect(row).toMatchObject({ status: 'arrived', approved_price_cents: 335677 })
  expect((await pg.query(`SELECT status FROM job_estimates WHERE service_order_id=$1`, [id])).rows[0]).toMatchObject({ status: 'converted' })
})

it('moveBaseEligibility is a pure gate with specific reasons', () => {
  const base = { id: 'x', status: 'arrived', source: 'quick_entry', serviceType: 'retail', customerName: 'A',
    startedAt: null, completedAt: null, cancelledAt: null, deliveredAt: null, vehicle: 'v', assignmentCount: 0,
    estimateId: null, qbInvoiceId: null, qbInvoiceNumber: null, qbStatus: 'none', qbSentAt: null }
  expect(moveBaseEligibility(base as any)).toEqual({ ok: true })
  expect(moveBaseEligibility({ ...base, serviceType: 'dealer_in' } as any)).toMatchObject({ ok: false, code: 'dealer' })
  expect(moveBaseEligibility({ ...base, status: 'in_progress' } as any)).toMatchObject({ ok: false, code: 'not_waiting' })
})
