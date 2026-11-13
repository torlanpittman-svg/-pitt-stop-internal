/**
 * REAL Postgres (PGlite) tests for job expenses: the actual migration SQL + the actual queries. Proves that
 * a job association is a LINK to one purchase — never a second expense, a customer price or an invoice line.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as schema from '@/drizzle/schema'

const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/platform/db', () => ({ getDb: () => h.db }))

import { createReceipt, fileReceipt, getReceipt, monthlyExpenseReport, reopenReceipt, possibleDuplicateFor, applyRetryExtraction, claimRetryExtraction } from './db'
import { allocateReceipt, changeAllocation, removeAllocation, listJobExpenses, listLinkableReceipts, searchJobs, searchTokens, allocationViewsFor, getJobRef } from './job-expenses'
import { getReceiptCoverage } from '@/apps/finance/receipts-cfo'
import type { CategoryChoice } from './types'

const migPath = (f: string) => fileURLToPath(new URL(`../../drizzle/migrations/manual/${f}`, import.meta.url))
const splitStatements = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
async function applyMigration(c: PGlite, f: string) { for (const stmt of splitStatements(readFileSync(migPath(f), 'utf8'))) await c.query(stmt) }

let client: PGlite
const actor = { name: 'Torlan', key: 'torlan' }
const single = (key: string): CategoryChoice => ({ kind: 'single', key: key as never })
let n = 0
async function receipt(over: Record<string, unknown> = {}, file: Record<string, unknown> | false = {}) {
  n++
  const { id } = await createReceipt({
    storage: 'blob_private', storageRef: `business-receipts/h${n}.jpg`, filename: 'r.jpg', contentType: 'image/jpeg', imageHash: `h${n}`, byteSize: 100,
    aiStatus: 'extracted', aiModel: 'gpt-4o', aiRaw: {}, aiExtracted: {}, confidence: {}, uploadedBy: 'Torlan', uploadedByKey: 'torlan', ...over,
  } as never)
  if (file !== false) {
    await fileReceipt(id, {
      entity: 'detail', category: single('parts'), funding: 'business', paymentMethod: 'card', accountRef: '*2649', paymentLast4: '0320',
      vendor: 'Tesla Inc.', receiptDate: '2026-11-13', totalCents: 8021, ...file,
    } as never, actor)
  }
  return id
}
async function job(orderNumber = 'SO-20261113-0001', customer = 'Huong Do', vin = '7SAYGDED2TA431723', ymm: [string, string, string] = ['2026', 'Tesla', 'Model Y']) {
  const v = await client.query<{ id: string }>(`INSERT INTO vehicles(year,make,model,vin) VALUES($2,$3,$4,$1) RETURNING id`, [vin, ...ymm])
  const o = await client.query<{ id: string }>(`INSERT INTO service_orders(order_number,vehicle_id,customer_name) VALUES($1,$2,$3) RETURNING id`, [orderNumber, v.rows[0].id, customer])
  return o.rows[0].id
}
const count = async (table: string) => Number((await client.query<{ n: string }>(`SELECT count(*) n FROM ${table}`)).rows[0].n)

beforeAll(async () => {
  client = new PGlite()
  await client.exec(`
    CREATE TABLE vehicles(id uuid primary key default gen_random_uuid(), year text, make text, model text, vin text, created_at timestamptz default now());
    CREATE TABLE inventory_vehicles(id uuid primary key default gen_random_uuid(), vehicle_id uuid references vehicles(id), stock_number text, created_at timestamptz default now());
    CREATE TABLE service_orders(id uuid primary key default gen_random_uuid(), order_number varchar(20) not null unique, vehicle_id uuid references vehicles(id), status varchar(24) not null default 'arrived', customer_name varchar(200), created_at timestamptz default now());
    CREATE TABLE job_parts(id uuid primary key default gen_random_uuid(), service_order_id uuid not null references service_orders(id), description text not null, quantity numeric(10,2) not null default 1, unit_cost_cents integer, sell_price_cents integer, supply varchar(12) not null default 'shop', status varchar(24) not null default 'needed');
    CREATE TABLE job_line_items(id uuid primary key default gen_random_uuid(), service_order_id uuid, amount_cents integer);
  `)
  for (const f of ['0038_business_receipts.sql', '0039_business_receipts_dedup.sql', '0040_business_receipts_hardening.sql', '0042_business_receipts_filing.sql',
    '0044_business_receipts_clarified.sql', '0045_business_receipts_capture_id.sql', '0043_fin_receipt_matches.sql', '0078_expense_allocations.sql']) await applyMigration(client, f)
  await applyMigration(client, '0078_expense_allocations.sql') // idempotent re-apply must not throw
  h.db = drizzle(client, { schema })
})
beforeEach(async () => { await client.exec(`TRUNCATE expense_allocations, business_receipts, job_parts, job_line_items, service_orders, inventory_vehicles, vehicles, fin_receipt_matches CASCADE;`) })
afterAll(async () => { await client.close() })

describe('acceptance — the existing Tesla receipt linked to the Huong Do job', () => {
  it('links the EXISTING $80.21 receipt: exactly $80.21 on the job, no new expense, history preserved', async () => {
    const orderId = await job()
    const receiptId = await receipt({ subtotalCents: 7100, taxCents: 0 })
    const before = await getReceipt(receiptId)
    const reportBefore = await monthlyExpenseReport('2026-11')
    const coverageBefore = await getReceiptCoverage('2026-11')

    const res = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)
    expect(res.ok).toBe(true)

    const exp = await listJobExpenses(orderId)
    expect(exp.recordedCents).toBe(8021)            // exactly $80.21
    expect(exp.recordedCount).toBe(1)
    expect(exp.items).toHaveLength(1)
    expect(exp.items[0]).toMatchObject({
      receiptId, vendor: 'Tesla Inc.', receiptDate: '2026-11-13', amountCents: 8021, wholePurchase: true,
      paymentLabel: 'AMB debit ••0320', recorded: true, receiptUrl: `/api/expenses/receipt/${receiptId}/image`,
      bankMatch: 'none', qbSyncStatus: 'export_ready',   // not assumed matched; not claimed posted
    })
    // ONE purchase: still one receipt row, and every business total is unchanged by the job link.
    expect(await count('business_receipts')).toBe(1)
    const reportAfter = await monthlyExpenseReport('2026-11')
    expect(reportAfter.purchasesTotalCents).toBe(8021)
    expect(reportAfter.purchasesTotalCents).toBe(reportBefore.purchasesTotalCents)
    expect(reportAfter.businessCashOutflowCents).toBe(reportBefore.businessCashOutflowCents)
    expect(reportAfter.completeCount).toBe(1)
    const coverageAfter = await getReceiptCoverage('2026-11')
    expect(coverageAfter.purchasesTotalCents).toBe(coverageBefore.purchasesTotalCents)
    expect(coverageAfter.unreconciledCents).toBe(8021) // still NOT matched to a bank transaction
    // The receipt itself is untouched apart from one appended audit entry.
    const after = await getReceipt(receiptId)
    expect(after).toMatchObject({ status: 'filed', totalCents: 8021, storageRef: before!.storageRef, imageHash: before!.imageHash, filedBy: 'Torlan' })
    const log = after!.auditLog as { action: string }[]
    expect(log.slice(0, (before!.auditLog as unknown[]).length)).toEqual(before!.auditLog)
    expect(log[log.length - 1]).toMatchObject({ action: 'allocated', actor: 'Torlan' })
  })

  it('is idempotent — linking twice (double-tap / retry) keeps ONE link and $80.21', async () => {
    const orderId = await job(); const receiptId = await receipt()
    const a = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)
    const b = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)
    expect(b).toMatchObject({ ok: true, already: true, id: a.id })
    expect(await count('expense_allocations')).toBe(1)
    expect((await listJobExpenses(orderId)).recordedCents).toBe(8021)
  })
})

describe('a job expense needs no customer price and never touches the invoice', () => {
  it('saves our cost with no selling price anywhere — no part line, no invoice line is created', async () => {
    const orderId = await job(); const receiptId = await receipt()
    await allocateReceipt({ receiptId, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)
    expect(await count('job_parts')).toBe(0)        // "not priced yet" stays not priced — never a $0 line
    expect(await count('job_line_items')).toBe(0)
    expect((await listJobExpenses(orderId)).recordedCents).toBe(8021)
  })
  it('a receipt still in review is attached but kept OUT of the recorded total', async () => {
    const orderId = await job(); const receiptId = await receipt({ totalCents: 8021 }, false)
    expect((await allocateReceipt({ receiptId, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)).ok).toBe(true)
    const exp = await listJobExpenses(orderId)
    expect(exp).toMatchObject({ recordedCents: 0, recordedCount: 0, pendingCents: 8021, pendingCount: 1 })
  })
  it('a rejected receipt cannot be linked, and a rejected one drops off the job', async () => {
    const orderId = await job(); const receiptId = await receipt()
    await allocateReceipt({ receiptId, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)
    await reopenReceipt(receiptId, 'Torlan')
    await client.query(`UPDATE business_receipts SET status='rejected' WHERE id=$1`, [receiptId])
    expect((await listJobExpenses(orderId)).items).toHaveLength(0)
    const other = await job('SO-2', 'Other', 'VINOTHER000000002')
    expect((await allocateReceipt({ receiptId, target: 'job', serviceOrderId: other, amountCents: 100 }, actor)).ok).toBe(false)
  })
  it('a whole-purchase link follows a corrected receipt total (one source of truth)', async () => {
    const orderId = await job(); const receiptId = await receipt()
    await allocateReceipt({ receiptId, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)
    await reopenReceipt(receiptId, 'Torlan')
    await fileReceipt(receiptId, { entity: 'detail', category: single('parts'), funding: 'business', paymentMethod: 'card', vendor: 'Tesla Inc.', receiptDate: '2026-11-13', totalCents: 8521 } as never, actor)
    expect((await listJobExpenses(orderId)).recordedCents).toBe(8521)
    expect((await monthlyExpenseReport('2026-11')).purchasesTotalCents).toBe(8521)
  })
})

describe('splitting one purchase across jobs and overhead', () => {
  it('splits reconcile to the total, the remainder stays visible, and the business total never grows', async () => {
    const a = await job('SO-A', 'Ann', 'VINAAAAAAAAAAAAA1'); const b = await job('SO-B', 'Bob', 'VINBBBBBBBBBBBBB2')
    const receiptId = await receipt({}, { vendor: 'NAPA', totalCents: 10000 })
    expect((await allocateReceipt({ receiptId, target: 'job', serviceOrderId: a, amountCents: 4000 }, actor)).ok).toBe(true)
    expect((await allocateReceipt({ receiptId, target: 'job', serviceOrderId: b, amountCents: 3500 }, actor)).ok).toBe(true)
    const ea = await listJobExpenses(a)
    expect(ea.recordedCents).toBe(4000)
    expect(ea.items[0].purchase).toMatchObject({ state: 'partial', allocatedCents: 7500, unallocatedCents: 2500 })
    expect((await listJobExpenses(b)).recordedCents).toBe(3500)
    // the rest is overhead → fully reconciled
    expect((await allocateReceipt({ receiptId, target: 'overhead', amountCents: 2500 }, actor)).ok).toBe(true)
    expect((await listJobExpenses(a)).items[0].purchase.state).toBe('full')
    // 3 allocations, still ONE $100.00 expense
    expect((await monthlyExpenseReport('2026-11')).purchasesTotalCents).toBe(10000)
    const views = (await allocationViewsFor([receiptId])).get(receiptId)!
    expect(views.reduce<number>((sum, v) => sum + (v.effectiveCents ?? 0), 0)).toBe(10000)
  })
  it('refuses a split that would exceed the purchase total', async () => {
    const a = await job('SO-A', 'Ann', 'VINAAAAAAAAAAAAA1'); const b = await job('SO-B', 'Bob', 'VINBBBBBBBBBBBBB2')
    const receiptId = await receipt({}, { vendor: 'NAPA', totalCents: 10000 })
    await allocateReceipt({ receiptId, target: 'job', serviceOrderId: a, amountCents: 7000 }, actor)
    const over = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: b, amountCents: 3001 }, actor)
    expect(over.ok).toBe(false)
    expect(over.error).toContain('$30.00 unassigned')
    expect(await count('expense_allocations')).toBe(1)
  })
  it('a purchase wholly on one job cannot also be put on a second job', async () => {
    const a = await job('SO-A', 'Ann', 'VINAAAAAAAAAAAAA1'); const b = await job('SO-B', 'Bob', 'VINBBBBBBBBBBBBB2')
    const receiptId = await receipt()
    await allocateReceipt({ receiptId, target: 'job', serviceOrderId: a, amountCents: null }, actor)
    expect((await allocateReceipt({ receiptId, target: 'job', serviceOrderId: b, amountCents: null }, actor)).ok).toBe(false)
    expect((await allocateReceipt({ receiptId, target: 'job', serviceOrderId: b, amountCents: 100 }, actor)).ok).toBe(false)
  })
  it('the database itself refuses a second active whole-purchase row and a bad target', async () => {
    const a = await job('SO-A', 'Ann', 'VINAAAAAAAAAAAAA1'); const b = await job('SO-B', 'Bob', 'VINBBBBBBBBBBBBB2')
    const receiptId = await receipt()
    await client.query(`INSERT INTO expense_allocations(receipt_id,target,service_order_id) VALUES($1,'job',$2)`, [receiptId, a])
    await expect(client.query(`INSERT INTO expense_allocations(receipt_id,target,service_order_id) VALUES($1,'job',$2)`, [receiptId, b])).rejects.toThrow()
    await expect(client.query(`INSERT INTO expense_allocations(receipt_id,target) VALUES($1,'job')`, [receiptId])).rejects.toThrow()
    await expect(client.query(`INSERT INTO expense_allocations(receipt_id,target,amount_cents) VALUES($1,'overhead',0)`, [receiptId])).rejects.toThrow()
  })
})

describe('correcting and reassigning — audited, nothing deleted', () => {
  it('moves a purchase to the right job; the old row is kept as removed and points at its replacement', async () => {
    const wrong = await job('SO-WRONG', 'Wrong', 'VINWRONG00000001'); const right = await job()
    const receiptId = await receipt()
    const first = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: wrong, amountCents: null }, actor)
    const moved = await changeAllocation(first.id!, { serviceOrderId: right }, 'attached to the wrong job', { name: 'Dana', key: 'dana' })
    expect(moved.ok).toBe(true)
    expect((await listJobExpenses(wrong)).items).toHaveLength(0)
    expect((await listJobExpenses(right)).recordedCents).toBe(8021)
    const rows = (await client.query<{ id: string; status: string; replaced_by: string | null; removed_by: string | null; removed_reason: string | null }>(`SELECT id,status,replaced_by,removed_by,removed_reason FROM expense_allocations ORDER BY created_at`)).rows
    expect(rows).toHaveLength(2)                    // history preserved — never deleted
    expect(rows[0]).toMatchObject({ status: 'removed', replaced_by: moved.id, removed_by: 'Dana', removed_reason: 'attached to the wrong job' })
    expect(rows[1].status).toBe('active')
    const log = (await getReceipt(receiptId))!.auditLog as { action: string; actor: string; note?: string; changes?: Record<string, { from: string; to: string }> }[]
    const change = log.find((e) => e.action === 'allocation_changed')!
    expect(change).toMatchObject({ actor: 'Dana', note: 'attached to the wrong job' })
    expect(change.changes!.allocation.from).toContain(wrong)
    expect(change.changes!.allocation.to).toContain(right)
    expect((await monthlyExpenseReport('2026-11')).purchasesTotalCents).toBe(8021) // moving it changes no total
  })
  it('an invalid correction restores the original assignment untouched', async () => {
    const a = await job('SO-A', 'Ann', 'VINAAAAAAAAAAAAA1')
    const receiptId = await receipt({}, { totalCents: 10000 })
    const first = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: a, amountCents: 6000 }, actor)
    const bad = await changeAllocation(first.id!, { amountCents: 10001 }, null, actor)
    expect(bad.ok).toBe(false)
    expect((await listJobExpenses(a)).recordedCents).toBe(6000)
  })
  it('changing whole → split amount is a correction with history', async () => {
    const a = await job('SO-A', 'Ann', 'VINAAAAAAAAAAAAA1')
    const receiptId = await receipt({}, { totalCents: 10000 })
    const first = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: a, amountCents: null }, actor)
    expect((await changeAllocation(first.id!, { amountCents: 4000 }, 'only part was for this car', actor)).ok).toBe(true)
    const exp = await listJobExpenses(a)
    expect(exp.recordedCents).toBe(4000)
    expect(exp.items[0].purchase).toMatchObject({ state: 'partial', unallocatedCents: 6000 })
  })
  it('removing takes it off the job only — the receipt stays filed and counted once', async () => {
    const a = await job(); const receiptId = await receipt()
    const first = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: a, amountCents: null }, actor)
    expect((await removeAllocation(first.id!, 'not for this car', actor)).ok).toBe(true)
    expect((await removeAllocation(first.id!, 'again', actor)).ok).toBe(true) // idempotent
    expect((await listJobExpenses(a)).items).toHaveLength(0)
    expect((await getReceipt(receiptId))!.status).toBe('filed')
    expect((await monthlyExpenseReport('2026-11')).purchasesTotalCents).toBe(8021)
    expect(((await getReceipt(receiptId))!.auditLog as { action: string }[]).filter((e) => e.action === 'allocation_removed')).toHaveLength(1)
  })
})

describe('a job part and its receipt are one purchase', () => {
  it('a typed part cost is shown separately and NOT added to the receipt-backed total', async () => {
    const orderId = await job(); const receiptId = await receipt()
    const p = await client.query<{ id: string }>(`INSERT INTO job_parts(service_order_id,description,quantity,unit_cost_cents) VALUES($1,'Seat cushion foam',1,7100) RETURNING id`, [orderId])
    const link = await allocateReceipt({ receiptId, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)
    let exp = await listJobExpenses(orderId)
    expect(exp.recordedCents).toBe(8021)            // NOT 8021 + 7100
    expect(exp.unlinkedPartCostCents).toBe(7100)
    // tie the receipt to the part → reconciled, nothing left unlinked
    expect((await changeAllocation(link.id!, { jobPartId: p.rows[0].id }, null, actor)).ok).toBe(true)
    exp = await listJobExpenses(orderId)
    expect(exp.recordedCents).toBe(8021)
    expect(exp.unlinkedPartCosts).toHaveLength(0)
    expect(exp.items[0].jobPartId).toBe(p.rows[0].id)
  })
  it('refuses to tie a receipt to a part on a different job', async () => {
    const a = await job('SO-A', 'Ann', 'VINAAAAAAAAAAAAA1'); const b = await job('SO-B', 'Bob', 'VINBBBBBBBBBBBBB2')
    const receiptId = await receipt()
    const p = await client.query<{ id: string }>(`INSERT INTO job_parts(service_order_id,description,unit_cost_cents) VALUES($1,'Other part',500) RETURNING id`, [b])
    expect((await allocateReceipt({ receiptId, target: 'job', serviceOrderId: a, amountCents: null, jobPartId: p.rows[0].id }, actor)).ok).toBe(false)
  })
})

describe('finding jobs and already-filed receipts', () => {
  it('searches jobs by customer name, vehicle, VIN and job number', async () => {
    const id = await job()
    await job('SO-20261101-0009', 'Kelvin Smith', '1FTFW1234567ABCDE', ['2019', 'Ford', 'F-150'])
    for (const q of ['huong', 'tesla model y', '431723', 'SO-20261113', 'do 2026']) {
      const hits = await searchJobs(q)
      expect(hits.map((j) => j.id), q).toEqual([id])
    }
    expect(await searchJobs('zzzz')).toEqual([])
    expect(await searchJobs('h')).toEqual([])        // too short to search
    expect((await getJobRef(id))).toMatchObject({ orderNumber: 'SO-20261113-0001', customerName: 'Huong Do', vehicle: '2026 Tesla Model Y', vin: '7SAYGDED2TA431723' })
    expect(searchTokens('  50%_off  tesla ')).toEqual(['50off', 'tesla'])   // LIKE wildcards stripped
  })
  it('cancelled jobs are not offered', async () => {
    const id = await job()
    await client.query(`UPDATE service_orders SET status='cancelled' WHERE id=$1`, [id])
    expect(await searchJobs('huong')).toEqual([])
  })
  it('lists filed receipts that still have something to assign; a fully assigned one drops out', async () => {
    const orderId = await job()
    const tesla = await receipt({}, { invoiceNumber: '3000H0000513594' })
    const napa = await receipt({}, { vendor: 'NAPA', totalCents: 4000 })
    expect((await listLinkableReceipts('')).map((r) => r.id).sort()).toEqual([tesla, napa].sort())
    expect((await listLinkableReceipts('3000h0000')).map((r) => r.id)).toEqual([tesla])
    await allocateReceipt({ receiptId: tesla, target: 'job', serviceOrderId: orderId, amountCents: null }, actor)
    expect((await listLinkableReceipts('')).map((r) => r.id)).toEqual([napa])
  })
})

describe('duplicate evidence at capture + the new read-back fields', () => {
  it('flags a second capture of the same vendor invoice number even when the date was misread', async () => {
    const first = await receipt({}, { invoiceNumber: '3000H0000513594', receiptDate: '2026-11-13' })
    const second = await receipt({ vendor: 'Tesla Inc.', receiptDate: '2020-11-13', totalCents: 8021, }, false)
    await client.query(`UPDATE business_receipts SET invoice_number='3000H0000513594' WHERE id=$1`, [second])
    expect((await possibleDuplicateFor(second))?.id).toBe(first)
  })
  it('an equal total from a different vendor is not a duplicate', async () => {
    await receipt()
    const other = await receipt({ vendor: 'NAPA', receiptDate: '2026-11-13', totalCents: 8021 }, false)
    expect(await possibleDuplicateFor(other)).toBeNull()
  })
  it('a read stores shipping / invoice # / order # / description without overwriting typed values', async () => {
    const id = await receipt({ vendor: null }, false)
    await client.query(`UPDATE business_receipts SET description='typed by hand' WHERE id=$1`, [id])
    const claim = await claimRetryExtraction(id)
    if (!claim.ok) throw new Error('claim failed')
    await applyRetryExtraction(id, claim.token, {
      aiStatus: 'extracted', aiModel: 'gpt-4o', aiRaw: {}, aiExtracted: {}, confidence: {},
      vendor: 'Tesla Inc.', totalCents: 8021, subtotalCents: 7100, taxCents: 0, shippingCents: 921,
      invoiceNumber: '3000H0000513594', orderNumber: 'GPO-3Y3WMP6N16', description: 'seat cushion foam',
    }, 'Torlan')
    expect(await getReceipt(id)).toMatchObject({ shippingCents: 921, invoiceNumber: '3000H0000513594', orderNumber: 'GPO-3Y3WMP6N16', description: 'typed by hand', totalCents: 8021 })
  })
})
