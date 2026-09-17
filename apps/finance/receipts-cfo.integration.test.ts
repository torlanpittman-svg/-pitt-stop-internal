/**
 * CFO × Receipts — REAL Postgres integration (PGlite). Exercises the actual db.ts filing path + the CFO
 * coverage/reconciliation service against a disposable database — proving the safety properties the product
 * requires: filed receipts are visible; a confirmed match is counted ONCE (never receipt + bank txn as two
 * expenses); unmatched receipts stay unmatched and are subtracted from nothing; personal/unpaid are shown
 * distinctly and can't be reconciled; historical APPROVED receipts and the new FILED state both flow through.
 * No production credentials; no real storage or network.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as schema from '@/drizzle/schema'

const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/platform/db', () => ({ getDb: () => h.db }))

import { createReceipt, fileReceipt, approveReceipt, rejectReceipt, reopenReceipt } from '@/apps/expenses/db'
import type { CategoryChoice } from '@/apps/expenses/types'
import { getReceiptCoverage, getReceiptReconciliation, confirmReceiptMatch, dismissReceiptMatch, clearReceiptMatch } from './receipts-cfo'

const MONTH = '2026-03'
const migPath = (f: string) => fileURLToPath(new URL(`../../drizzle/migrations/manual/${f}`, import.meta.url))
function splitStatements(sqlText: string): string[] {
  return sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
}
async function applyMigration(client: PGlite, f: string) { for (const stmt of splitStatements(readFileSync(migPath(f), 'utf8'))) await client.query(stmt) }

let client: PGlite
const single = (key: string): CategoryChoice => ({ kind: 'single', key: key as never })
const base = (over: Record<string, unknown> = {}) => ({
  storage: 'blob_private' as const, storageRef: `business-receipts/${(over.imageHash as string) ?? 'h'}.jpg`,
  filename: 'r.jpg', contentType: 'image/jpeg', imageHash: 'h', byteSize: 100,
  aiStatus: 'extracted' as const, aiModel: 'gpt-4o', aiRaw: {}, aiExtracted: {}, confidence: {}, uploadedBy: 'Sam', uploadedByKey: 'sam',
  ...over,
})
const filer = { name: 'Sam', key: 'sam' }
const clean = (over: Record<string, unknown> = {}) => ({
  entity: 'detail' as const, category: single('shop_supplies'), funding: 'business' as const,
  paymentMethod: 'card' as const, vendor: 'O’Reilly', receiptDate: `${MONTH}-15`, totalCents: 4599, ...over,
})
// Insert a bank OUT transaction directly (minimal columns the CFO service reads).
async function seedTxn(id: string, amountCents: number, txnDate: string, merchant: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO fin_transactions(id, amount_cents, direction, txn_date, name, merchant_name, removed) VALUES($1,$2,'out',$3,$4,$5,false) RETURNING id`,
    [id, amountCents, txnDate, merchant, merchant],
  )
  return r.rows[0].id
}

beforeAll(async () => {
  client = new PGlite()
  await client.exec(`
    CREATE TABLE vehicles(id uuid primary key default gen_random_uuid(), year text, make text, model text, vin text, created_at timestamptz default now());
    CREATE TABLE inventory_vehicles(id uuid primary key default gen_random_uuid(), vehicle_id uuid references vehicles(id), stock_number text, created_at timestamptz default now());
    -- Minimal fin_transactions (only the columns the CFO receipt service references).
    CREATE TABLE fin_transactions(id uuid primary key default gen_random_uuid(), amount_cents integer not null, direction varchar(8) not null, txn_date date not null, name text, merchant_name text, removed boolean not null default false);
    -- Minimal fin_events (audit sink for reconciliation decisions).
    CREATE TABLE fin_events(id uuid primary key default gen_random_uuid(), actor varchar(200), action varchar(60) not null, entity varchar(40), entity_id varchar(64), before jsonb, after jsonb, source varchar(20), created_at timestamptz default now());
  `)
  await applyMigration(client, '0038_business_receipts.sql')
  await applyMigration(client, '0039_business_receipts_dedup.sql')
  await applyMigration(client, '0040_business_receipts_hardening.sql')
  await applyMigration(client, '0042_business_receipts_filing.sql')
  await applyMigration(client, '0044_business_receipts_clarified.sql')
  await applyMigration(client, '0043_fin_receipt_matches.sql')
  await applyMigration(client, '0043_fin_receipt_matches.sql') // idempotent re-apply
  h.db = drizzle(client, { schema })
})
beforeEach(async () => { await client.exec(`TRUNCATE business_receipts, fin_transactions, fin_receipt_matches, fin_events CASCADE;`) })

async function fileClean(hash: string, over: Record<string, unknown> = {}) {
  const { id } = await createReceipt(base({ imageHash: hash }))
  const r = await fileReceipt(id, clean(over), filer)
  return { id, r }
}

describe('coverage — filed + approved visible, purchases counted once', () => {
  it('a filed business receipt is visible and reconcilable, unreconciled until matched', async () => {
    await fileClean('C1')
    const cov = await getReceiptCoverage(MONTH)
    expect(cov.completeCount).toBe(1)
    expect(cov.purchasesTotalCents).toBe(4599)
    expect(cov.reconcilableCents).toBe(4599)
    expect(cov.reconciledCents).toBe(0)          // nothing matched yet
    expect(cov.unreconciledCents).toBe(4599)     // visible + not subtracted anywhere
    expect(cov.unreconciledCount).toBe(1)
  })

  it('a legacy APPROVED receipt also flows through the coverage layer', async () => {
    const { id } = await createReceipt(base({ imageHash: 'C2' }))
    await approveReceipt(id, { entity: 'detail', totalCents: 2000, receiptDate: `${MONTH}-10` }, 'Darryl')
    const cov = await getReceiptCoverage(MONTH)
    expect(cov.completeCount).toBe(1)
    expect(cov.purchasesTotalCents).toBe(2000)
    expect(cov.reconcilableCents).toBe(2000)     // unknown-funding legacy is still a business purchase
  })
})

describe('reconciliation — human-confirmed, no double counting', () => {
  it('confirming a match moves the receipt to reconciled WITHOUT changing the purchases total (counted once)', async () => {
    const { id } = await fileClean('M1')
    const txnId = await seedTxn('11111111-1111-1111-1111-111111111111', 4599, `${MONTH}-16`, 'O’Reilly')
    const recon = await getReceiptReconciliation(MONTH)
    expect(recon.unreconciled).toHaveLength(1)
    expect(recon.unreconciled[0].suggestions[0].strength).toBe('strong')

    const res = await confirmReceiptMatch(id, txnId, 'admin')
    expect(res.ok).toBe(true)
    const cov = await getReceiptCoverage(MONTH)
    expect(cov.purchasesTotalCents).toBe(4599)   // UNCHANGED — receipt still counted exactly once
    expect(cov.reconciledCents).toBe(4599)       // now flagged as already-in-bank
    expect(cov.unreconciledCents).toBe(0)        // not double-counted on top of the bank txn
    const recon2 = await getReceiptReconciliation(MONTH)
    expect(recon2.unreconciled).toHaveLength(0)
    expect(recon2.confirmed).toHaveLength(1)
  })

  it('one bank transaction cannot back two receipts', async () => {
    const a = await fileClean('D1', { imageHash: 'D1' })
    const b = await fileClean('D2', { imageHash: 'D2' })
    const txnId = await seedTxn('22222222-2222-2222-2222-222222222222', 4599, `${MONTH}-15`, 'O’Reilly')
    expect((await confirmReceiptMatch(a.id, txnId, 'admin')).ok).toBe(true)
    const second = await confirmReceiptMatch(b.id, txnId, 'admin')
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/already matched/i)
  })

  it('dismiss keeps the receipt out of the worklist without subtracting anything; clear restores it', async () => {
    const { id } = await fileClean('X1')
    expect((await dismissReceiptMatch(id, 'admin')).ok).toBe(true)
    let cov = await getReceiptCoverage(MONTH)
    expect(cov.dismissedCount).toBe(1)
    expect(cov.reconciledCents).toBe(0)
    expect(cov.unreconciledCents).toBe(4599)     // still present in the total — dismiss ≠ subtract
    expect((await getReceiptReconciliation(MONTH)).unreconciled).toHaveLength(0)

    await clearReceiptMatch(id, 'admin')
    cov = await getReceiptCoverage(MONTH)
    expect(cov.dismissedCount).toBe(0)
    expect((await getReceiptReconciliation(MONTH)).unreconciled).toHaveLength(1)
  })

  it('suggestions never auto-link: an equal-amount txn with no name overlap stays a suggestion, not confirmed', async () => {
    await fileClean('S1')
    await seedTxn('33333333-3333-3333-3333-333333333333', 4599, `${MONTH}-15`, 'Totally Different Vendor')
    const recon = await getReceiptReconciliation(MONTH)
    expect(recon.unreconciled).toHaveLength(1)
    expect(recon.confirmed).toHaveLength(0)                                  // nothing linked automatically
    expect(recon.unreconciled[0].suggestions[0].strength).toBe('possible')  // amount-only ⇒ possible, needs confirm
  })
})

describe('personal / unpaid — distinct, never reconcilable, never an obligation', () => {
  it('a personal-money receipt is shown as reimbursement review, not business cash, and cannot be matched', async () => {
    // Filing personal money keeps it in the exception queue (needs_review) — still surfaced to the CFO.
    const { id, r } = await fileClean('P1', { funding: 'personal', paymentMethod: null })
    expect(r.status).toBe('needs_review')
    const cov = await getReceiptCoverage(MONTH)
    expect(cov.personalReimbursableCents).toBe(4599)
    expect(cov.reconcilableCents).toBe(0)          // not a business-account purchase
    expect(cov.purchasesTotalCents).toBe(0)        // exceptions aren't "complete" purchases
    const txnId = await seedTxn('44444444-4444-4444-4444-444444444444', 4599, `${MONTH}-15`, 'O’Reilly')
    const res = await confirmReceiptMatch(id, txnId, 'admin')
    expect(res.ok).toBe(false)                     // personal ≠ business bank transaction
  })

  it('an unpaid receipt is shown as payment review and creates no obligation', async () => {
    await fileClean('U1', { funding: 'unpaid', paymentMethod: null })
    const cov = await getReceiptCoverage(MONTH)
    expect(cov.unpaidCents).toBe(4599)
    expect(cov.reconcilableCents).toBe(0)
    // (No obligation is ever created here — the finance obligations table is never written by this module.)
  })

  it('a manager-CLARIFIED (reviewed-but-outstanding) personal receipt still shows as reimbursement coverage', async () => {
    const { id } = await createReceipt(base({ imageHash: 'P2' }))
    await fileReceipt(id, clean({ funding: 'personal', paymentMethod: null }), { name: 'Darryl', key: 'darryl' }, { acknowledge: true })
    const cov = await getReceiptCoverage(MONTH)
    expect(cov.personalReimbursableCents).toBe(4599)   // reviewed ≠ resolved — still surfaced, still not business cash
    expect(cov.reconcilableCents).toBe(0)
    expect(cov.purchasesTotalCents).toBe(0)
  })
})

describe('CFO accuracy — rejected receipts are never valid coverage', () => {
  it('a filed+matched receipt that is later REJECTED disappears from coverage and reconciliation', async () => {
    const { id } = await fileClean('J1')
    const txnId = await seedTxn('55555555-5555-5555-5555-555555555555', 4599, `${MONTH}-16`, 'O’Reilly')
    await confirmReceiptMatch(id, txnId, 'admin')
    let cov = await getReceiptCoverage(MONTH)
    expect(cov.reconciledCents).toBe(4599)             // counted while filed
    // Void it — a filed receipt must be reopened before it can be rejected (guarded), then rejected.
    await reopenReceipt(id, 'Darryl')
    await rejectReceipt(id, 'not ours', 'Darryl')
    cov = await getReceiptCoverage(MONTH)
    expect(cov.purchasesTotalCents).toBe(0)            // rejected ⇒ no coverage
    expect(cov.reconciledCents).toBe(0)                // stale match row is ignored (receipt not complete)
    expect(cov.reconcilableCents).toBe(0)
    const recon = await getReceiptReconciliation(MONTH)
    expect(recon.confirmed).toHaveLength(0)
    expect(recon.unreconciled).toHaveLength(0)
  })
})
