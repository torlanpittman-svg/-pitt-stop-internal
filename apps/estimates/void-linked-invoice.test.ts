/**
 * Voiding the invoice left on a vehicle that was moved back to Estimates. PGlite (minimal schema, like
 * move-to-estimates.test.ts) + mocked QuickBooks reads/writes; the pure removal planner is the real one.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { randomUUID } from 'node:crypto'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const qb = vi.hoisted(() => ({ voidInvoice: vi.fn(), readRetailInvoiceSnapshot: vi.fn() }))
vi.mock('@/apps/quickbooks/invoice-removal', () => qb)

import { getDb } from '@/platform/db'
import { voidLinkedInvoiceForEstimate } from './void-linked-invoice'

const pg = new PGlite()
afterAll(() => pg.close())

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE service_orders(id uuid PRIMARY KEY, status text, source text, service_type text);
    CREATE TABLE job_estimates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_order_id uuid UNIQUE,
      qb_invoice_id text, qb_invoice_number text, qb_sync_token text, qb_status text DEFAULT 'none', qb_content_hash text,
      qb_lines_fingerprint text, qb_sync_error text, qb_synced_at timestamptz, qb_sent_at timestamptz,
      qb_payment_status text DEFAULT 'none', qb_payment_id text, total_cents int, updated_at timestamptz, updated_by text);
    CREATE TABLE retail_invoice_members(anchor_estimate_id uuid, member_estimate_id uuid, state text DEFAULT 'pending');
    CREATE TABLE service_order_events(service_order_id uuid, event_type text, employee_name text, old_status text, new_status text, note text);
  `)
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})

const snapshot = (over: Record<string, unknown> = {}) => ({
  status: 'resolved', invoiceId: '24652', invoiceNumber: '100950', totalCents: 505537, balanceCents: 505537,
  emailStatus: 'NotSet', voided: false, salesLines: [{ id: '1', description: 'x', amountCents: 505537 }], ...over,
})

beforeEach(async () => {
  await pg.exec(`TRUNCATE service_orders, job_estimates, retail_invoice_members, service_order_events`)
  qb.readRetailInvoiceSnapshot.mockReset().mockResolvedValue(snapshot())
  qb.voidInvoice.mockReset().mockResolvedValue({ ok: true, invoiceId: '24652', invoiceNumber: '100950', totalCentsBefore: 505537, totalCentsAfter: 0 })
})

async function fixture(opts: { order?: Record<string, unknown>; estimate?: Record<string, unknown> } = {}) {
  const id = randomUUID()
  const o = { status: 'estimate', source: 'quick_entry', service_type: 'retail', ...(opts.order ?? {}) }
  await pg.query(`INSERT INTO service_orders(id, status, source, service_type) VALUES ($1,$2,$3,$4)`, [id, o.status, o.source, o.service_type])
  const e = { qb_invoice_id: '24652', qb_invoice_number: '100950', qb_status: 'created', qb_sent_at: null, qb_payment_status: 'none', qb_payment_id: null, ...(opts.estimate ?? {}) }
  const est = (await pg.query<{ id: string }>(
    `INSERT INTO job_estimates(service_order_id, qb_invoice_id, qb_invoice_number, qb_sync_token, qb_status, qb_content_hash, qb_lines_fingerprint,
       qb_sync_error, qb_synced_at, qb_sent_at, qb_payment_status, qb_payment_id, total_cents)
     VALUES ($1,$2,$3,'0',$4,'hash','fp','QuickBooks sync needed — a price changed.', now(), $5,$6,$7, 510687) RETURNING id`,
    [id, e.qb_invoice_id, e.qb_invoice_number, e.qb_status, e.qb_sent_at, e.qb_payment_status, e.qb_payment_id])).rows[0]
  return { id, estimateId: est.id }
}
const link = async (id: string) => (await pg.query<Record<string, unknown>>(
  `SELECT qb_invoice_id, qb_invoice_number, qb_sync_token, qb_status, qb_content_hash, qb_lines_fingerprint, qb_sync_error, total_cents FROM job_estimates WHERE service_order_id=$1`, [id])).rows[0]
const voidEvents = async (id: string) => (await pg.query<{ note: string; employee_name: string }>(
  `SELECT note, employee_name FROM service_order_events WHERE service_order_id=$1 AND event_type='qb_invoice_voided'`, [id])).rows
const run = (id: string, n = '100950') => voidLinkedInvoiceForEstimate({ orderId: id, expectedInvoiceNumber: n, actor: 'Torlan' })
const untouched = async (id: string) => {
  expect(qb.voidInvoice).not.toHaveBeenCalled()
  expect((await link(id)).qb_invoice_id).toBe('24652')
  expect(await voidEvents(id)).toEqual([])
}

it('voids the unsent, unpaid invoice proven to be this estimate’s, clears the link and appends one audit event', async () => {
  const { id, estimateId } = await fixture()
  const r = await run(id)
  expect(r).toMatchObject({ ok: true, qbAction: 'invoice_voided', invoiceId: '24652', invoiceNumber: '100950', wasCents: 505537 })
  expect(qb.readRetailInvoiceSnapshot).toHaveBeenCalledWith('24652', estimateId)   // PSID identity = this estimate
  expect(qb.voidInvoice).toHaveBeenCalledTimes(1)
  expect(qb.voidInvoice).toHaveBeenCalledWith({ invoiceId: '24652' })
  expect(await link(id)).toEqual({ qb_invoice_id: null, qb_invoice_number: null, qb_sync_token: null, qb_status: 'none',
    qb_content_hash: null, qb_lines_fingerprint: null, qb_sync_error: null, total_cents: 510687 })   // pricing untouched
  const ev = await voidEvents(id)
  expect(ev).toHaveLength(1)
  expect(ev[0]).toMatchObject({ employee_name: 'Torlan' })
  expect(ev[0].note).toContain('#100950 (24652)')
  expect(ev[0].note).toContain('was $5055.37')
})

it('is idempotent: a repeat request after a finished void touches nothing', async () => {
  const { id } = await fixture()
  await run(id)
  const again = await run(id)
  expect(again).toMatchObject({ ok: true, alreadyDone: true })
  expect(qb.voidInvoice).toHaveBeenCalledTimes(1)
  expect(await voidEvents(id)).toHaveLength(1)
})

it('recovers a crash after the QuickBooks void: already voided there → finishes the link clear without a second void', async () => {
  const { id } = await fixture()
  qb.readRetailInvoiceSnapshot.mockResolvedValue(snapshot({ voided: true, totalCents: 0, balanceCents: 0 }))
  const r = await run(id)
  expect(r).toMatchObject({ ok: true, qbAction: 'already_voided' })
  expect(qb.voidInvoice).not.toHaveBeenCalled()
  expect((await link(id)).qb_invoice_id).toBeNull()
  expect((await voidEvents(id))[0].note).toContain('already voided in QuickBooks')
})

it('requires the exact linked invoice number, in Pitt Stop and in QuickBooks', async () => {
  const { id } = await fixture()
  expect(await run(id, '100949')).toMatchObject({ ok: false, code: 'number_mismatch' })
  expect(await run(id, '')).toMatchObject({ ok: false, code: 'number_mismatch' })
  expect(qb.readRetailInvoiceSnapshot).not.toHaveBeenCalled()
  qb.readRetailInvoiceSnapshot.mockResolvedValue(snapshot({ invoiceNumber: '100951' }))
  expect(await run(id)).toMatchObject({ ok: false, code: 'number_mismatch' })
  await untouched(id)
})

it('refuses any payment or credit activity — locally recorded or a reduced QuickBooks balance', async () => {
  const paidLocally = await fixture({ estimate: { qb_payment_status: 'paid', qb_payment_id: '900' } })
  expect(await run(paidLocally.id)).toMatchObject({ ok: false, code: 'payment_activity' })
  await untouched(paidLocally.id)
  const { id } = await fixture()
  qb.readRetailInvoiceSnapshot.mockResolvedValue(snapshot({ balanceCents: 405537 }))
  expect(await run(id)).toMatchObject({ ok: false, code: 'payment_activity' })
  await untouched(id)
})

it('refuses an invoice already sent to the customer (app state or QuickBooks EmailSent)', async () => {
  const sentLocally = await fixture({ estimate: { qb_status: 'sent', qb_sent_at: new Date().toISOString() } })
  expect(await run(sentLocally.id)).toMatchObject({ ok: false, code: 'invoice_sent' })
  await untouched(sentLocally.id)
  const { id } = await fixture()
  qb.readRetailInvoiceSnapshot.mockResolvedValue(snapshot({ emailStatus: 'EmailSent' }))
  expect(await run(id)).toMatchObject({ ok: false, code: 'invoice_sent' })
  await untouched(id)
})

it('refuses when the invoice cannot be proven to be this estimate’s, or QuickBooks cannot be read', async () => {
  const { id } = await fixture()
  qb.readRetailInvoiceSnapshot.mockResolvedValue(snapshot({ status: 'ambiguous', ambiguousReason: 'psid_mismatch', salesLines: [] }))
  expect(await run(id)).toMatchObject({ ok: false, code: 'ambiguous' })
  qb.readRetailInvoiceSnapshot.mockRejectedValue(new Error('network'))
  expect(await run(id)).toMatchObject({ ok: false, code: 'qb_unreachable' })
  await untouched(id)
})

it('refuses a shared invoice, a dealer vehicle, and any order that is not in Estimates', async () => {
  const shared = await fixture()
  await pg.query(`INSERT INTO retail_invoice_members(anchor_estimate_id, member_estimate_id, state) VALUES ($1,$2,'applied')`, [shared.estimateId, randomUUID()])
  expect(await run(shared.id)).toMatchObject({ ok: false, code: 'shared_invoice' })
  const dealer = await fixture({ order: { source: 'dealer_checkin', service_type: 'dealer' } })
  expect(await run(dealer.id)).toMatchObject({ ok: false, code: 'dealer' })
  for (const status of ['arrived', 'in_progress', 'completed', 'cancelled']) {
    const job = await fixture({ order: { status } })
    expect(await run(job.id)).toMatchObject({ ok: false, code: 'not_estimate' })
    await untouched(job.id)
  }
  expect(await run(randomUUID())).toMatchObject({ ok: false, code: 'not_found' })
  expect(qb.readRetailInvoiceSnapshot).not.toHaveBeenCalled()
})

it('keeps the link and writes no audit event when the QuickBooks void fails', async () => {
  const { id } = await fixture()
  qb.voidInvoice.mockResolvedValue({ ok: false, error: 'stale SyncToken' })
  expect(await run(id)).toMatchObject({ ok: false, code: 'qb_write_failed' })
  expect((await link(id)).qb_invoice_id).toBe('24652')
  expect(await voidEvents(id)).toEqual([])
})

it('an estimate with no linked invoice has nothing to void', async () => {
  const { id } = await fixture({ estimate: { qb_invoice_id: null, qb_invoice_number: null, qb_status: 'none' } })
  expect(await run(id)).toMatchObject({ ok: false, code: 'no_invoice' })
  expect(qb.readRetailInvoiceSnapshot).not.toHaveBeenCalled()
})
