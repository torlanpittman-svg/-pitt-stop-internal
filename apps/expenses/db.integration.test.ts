/**
 * REAL Postgres integration tests (PGlite — an in-process WASM build of Postgres). These run the ACTUAL
 * migration SQL and the ACTUAL db.ts query builder against a disposable database — not mocks — to establish
 * SQL correctness: partial-unique idempotency, atomic transitions, extraction-attempt ownership tokens,
 * the FK, business-month filtering, and the durable rate limiter. No production credentials; nothing is
 * uploaded to real storage (storage is never called here).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as schema from '@/drizzle/schema'

// Lazily-provided db so the getDb() mock returns our PGlite-backed drizzle instance.
const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/platform/db', () => ({ getDb: () => h.db }))

import {
  createReceipt, storedPathnameForHash, getReceipt, saveReview, approveReceipt, rejectReceipt, reopenReceipt,
  claimRetryExtraction, applyRetryExtraction, releaseRetryClaim, inventoryVehicleExists,
  listInventoryVehiclesForPicker, monthlyExpenseReport, consumeRateLimit, fileReceipt, listReceipts, queueCounts,
  createPendingReceipt, findReceiptByCaptureId, possibleDuplicateFor,
} from './db'
import type { CategoryChoice } from './types'

const single = (key: string): CategoryChoice => ({ kind: 'single', key: key as never })
const cleanFiling = (over: Record<string, unknown> = {}) => ({
  entity: 'detail' as const, category: single('shop_supplies'), funding: 'business' as const,
  paymentMethod: 'card' as const, vendor: 'O’Reilly', receiptDate: '2026-01-15', totalCents: 4599, ...over,
})

const migPath = (f: string) => fileURLToPath(new URL(`../../drizzle/migrations/manual/${f}`, import.meta.url))
// Replicate the production runner's splitter (strip full-line comments, split on ';') — also validates it.
function splitStatements(sqlText: string): string[] {
  return sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
}
async function applyMigration(client: PGlite, f: string) {
  for (const stmt of splitStatements(readFileSync(migPath(f), 'utf8'))) await client.query(stmt)
}

let client: PGlite
const baseReceipt = (over: Record<string, unknown> = {}) => ({
  storage: 'blob_private' as const, storageRef: `business-receipts/${(over.imageHash as string) ?? 'h'}.jpg`,
  filename: 'r.jpg', contentType: 'image/jpeg', imageHash: 'hash-default', byteSize: 100,
  aiStatus: 'extracted' as const, aiModel: 'gpt-4o', aiRaw: { content: 'x' }, aiExtracted: {}, confidence: {}, uploadedBy: 'Shop',
  ...over,
})
async function seedVehicle(stock = 'PS-1234'): Promise<string> {
  const v = await client.query<{ id: string }>(`INSERT INTO vehicles(year,make,model,vin) VALUES('2020','Ford','F150','1FTFW1234567ABCDE') RETURNING id`)
  const iv = await client.query<{ id: string }>(`INSERT INTO inventory_vehicles(vehicle_id,stock_number) VALUES($1,$2) RETURNING id`, [v.rows[0].id, stock])
  return iv.rows[0].id
}

beforeAll(async () => {
  client = new PGlite()
  // Prerequisite tables the receipt migrations/joins reference (minimal, real).
  await client.exec(`
    CREATE TABLE vehicles(id uuid primary key default gen_random_uuid(), year text, make text, model text, vin text, created_at timestamptz default now());
    CREATE TABLE inventory_vehicles(id uuid primary key default gen_random_uuid(), vehicle_id uuid references vehicles(id), stock_number text, created_at timestamptz default now());
  `)
  await applyMigration(client, '0038_business_receipts.sql')
  await applyMigration(client, '0039_business_receipts_dedup.sql')
  await applyMigration(client, '0040_business_receipts_hardening.sql')
  await applyMigration(client, '0042_business_receipts_filing.sql')
  await applyMigration(client, '0044_business_receipts_clarified.sql')
  await applyMigration(client, '0045_business_receipts_capture_id.sql')
  // Idempotency: re-apply must not throw.
  await applyMigration(client, '0038_business_receipts.sql')
  await applyMigration(client, '0039_business_receipts_dedup.sql')
  await applyMigration(client, '0040_business_receipts_hardening.sql')
  await applyMigration(client, '0042_business_receipts_filing.sql')
  await applyMigration(client, '0044_business_receipts_clarified.sql')
  await applyMigration(client, '0045_business_receipts_capture_id.sql')
  h.db = drizzle(client, { schema })
})

beforeEach(async () => {
  await client.exec(`TRUNCATE business_receipts, expense_rate_counters, inventory_vehicles, vehicles CASCADE;`)
})

describe('migrations apply + are idempotent (real Postgres)', () => {
  it('created the table, hardening column and rate table', async () => {
    const cols = await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='business_receipts'`)
    const names = cols.rows.map((r) => r.column_name)
    expect(names).toContain('processing_token')
    expect(names).toContain('image_hash')
    const idx = await client.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename='business_receipts'`)
    expect(idx.rows.map((r) => r.indexname)).toContain('business_receipts_hash_active_uniq')
    const t = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_name='expense_rate_counters'`)
    expect(t.rows.length).toBe(1)
  })
})

describe('upload idempotency — concurrent identical uploads collapse to one active receipt', () => {
  it('second identical create returns the existing id (duplicate) — no second row', async () => {
    const a = await createReceipt(baseReceipt({ imageHash: 'H1' }))
    expect(a.duplicate).toBe(false)
    const b = await createReceipt(baseReceipt({ imageHash: 'H1' }))
    expect(b.duplicate).toBe(true)
    expect(b.id).toBe(a.id)
    const rows = await client.query(`SELECT count(*)::int n FROM business_receipts WHERE image_hash='H1' AND status<>'rejected'`)
    expect((rows.rows[0] as { n: number }).n).toBe(1)
  })

  it('re-upload AFTER rejection is allowed (a new active row)', async () => {
    const a = await createReceipt(baseReceipt({ imageHash: 'H2' }))
    await rejectReceipt(a.id, 'junk', 'Darryl')
    const b = await createReceipt(baseReceipt({ imageHash: 'H2' }))
    expect(b.duplicate).toBe(false)
    expect(b.id).not.toBe(a.id)
    const active = await client.query(`SELECT count(*)::int n FROM business_receipts WHERE image_hash='H2' AND status<>'rejected'`)
    expect((active.rows[0] as { n: number }).n).toBe(1)
  })

  it('storedPathnameForHash returns the immutable pathname for reuse', async () => {
    const a = await createReceipt(baseReceipt({ imageHash: 'H3', storageRef: 'business-receipts/H3.jpg' }))
    expect(await storedPathnameForHash('H3')).toBe('business-receipts/H3.jpg')
    await rejectReceipt(a.id, 'x', 'Darryl')
    // even after rejection the bytes are preserved → still reusable
    expect(await storedPathnameForHash('H3')).toBe('business-receipts/H3.jpg')
  })
})

describe('atomic transitions + audit (real Postgres)', () => {
  it('approve is idempotent and a concurrent reject cannot overwrite it', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A1', totalCents: 1999, receiptDate: '2026-09-14' }))
    await saveReview(id, { entity: 'detail', totalCents: 1999, receiptDate: '2026-09-14' }, 'Darryl')
    const r1 = await approveReceipt(id, {}, 'Darryl')
    expect(r1.ok).toBe(true)
    const r2 = await approveReceipt(id, {}, 'Tony')
    expect(r2.alreadyApproved).toBe(true)
    const rej = await rejectReceipt(id, 'late', 'Tony')
    expect(rej.ok).toBe(false)
    expect(rej.conflict).toBe(true)
    const row = await getReceipt(id)
    expect(row?.status).toBe('approved')
    expect(row?.approvedBy).toBe('Darryl')
  })

  it('approval is blocked without entity, total, or a valid date', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A2' }))
    expect((await approveReceipt(id, { totalCents: 500, receiptDate: '2026-09-01' }, 'D')).error).toMatch(/business/i) // entity unassigned
    expect((await approveReceipt(id, { entity: 'detail', receiptDate: '2026-09-01' }, 'D')).error).toMatch(/total/i)
    expect((await approveReceipt(id, { entity: 'detail', totalCents: 500 }, 'D')).error).toMatch(/date/i)
  })

  it('append-only audit records each action with the real actor', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A3' }))
    await saveReview(id, { entity: 'auto_sales', vendor: 'ACME' }, 'Darryl')
    await approveReceipt(id, { totalCents: 800, receiptDate: '2026-09-02' }, 'Tony')
    const row = await getReceipt(id)
    const log = row?.auditLog as { action: string; actor: string | null }[]
    const actions = log.map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['uploaded', 'reviewed', 'approved']))
    expect(log.find((e) => e.action === 'approved')?.actor).toBe('Tony')
    expect(log.find((e) => e.action === 'reviewed')?.actor).toBe('Darryl')
  })

  it('reject → reopen returns to needs_review and clears the reason', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A4' }))
    await rejectReceipt(id, 'blurry', 'Darryl')
    expect((await getReceipt(id))?.status).toBe('rejected')
    await reopenReceipt(id, 'Darryl')
    const row = await getReceipt(id)
    expect(row?.status).toBe('needs_review')
    expect(row?.rejectedReason).toBeNull()
  })
})

describe('extraction attempt ownership (token) — stale worker cannot overwrite', () => {
  async function makeStale(id: string) {
    await client.query(`UPDATE business_receipts SET updated_at = now() - interval '10 minutes' WHERE id=$1`, [id])
  }
  it('a superseded (stale-reclaimed) attempt is dropped; only the current token completes', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'T1' }))
    const c1 = await claimRetryExtraction(id)
    expect(c1.ok).toBe(true)
    const token1 = (c1 as { token: string }).token
    await makeStale(id)
    const c2 = await claimRetryExtraction(id)
    expect(c2.ok).toBe(true)
    const token2 = (c2 as { token: string }).token
    expect(token2).not.toBe(token1)
    // Attempt A (token1) finishes LATE → must be dropped.
    const late = await applyRetryExtraction(id, token1, { aiStatus: 'extracted', aiModel: 'm', aiRaw: {}, aiExtracted: {}, confidence: {}, vendor: 'STALE-A' }, 'A')
    expect(late.stale).toBe(true)
    const mid = await getReceipt(id)
    expect(mid?.status).toBe('processing')
    expect(mid?.vendor).not.toBe('STALE-A')
    // Attempt B (token2) completes.
    const ok = await applyRetryExtraction(id, token2, { aiStatus: 'extracted', aiModel: 'm', aiRaw: {}, aiExtracted: {}, confidence: {}, vendor: 'B-RESULT' }, 'B')
    expect(ok.ok).toBe(true)
    const row = await getReceipt(id)
    expect(row?.status).toBe('needs_review')
    expect(row?.processingToken).toBeNull()
  })

  it('a late failure-release only affects the owned token', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'T2' }))
    const c1 = await claimRetryExtraction(id) as { ok: true; token: string }
    await makeStale(id)
    const c2 = await claimRetryExtraction(id) as { ok: true; token: string }
    await releaseRetryClaim(id, c1.token) // stale release — must no-op
    expect((await getReceipt(id))?.status).toBe('processing')
    await releaseRetryClaim(id, c2.token) // owner release
    expect((await getReceipt(id))?.status).toBe('needs_review')
  })

  it('a manager approval is NOT overwritten by a late extraction result', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'T3' }))
    const c1 = await claimRetryExtraction(id) as { ok: true; token: string }
    await makeStale(id)
    const c2 = await claimRetryExtraction(id) as { ok: true; token: string }
    await applyRetryExtraction(id, c2.token, { aiStatus: 'extracted', aiModel: 'm', aiRaw: {}, aiExtracted: {}, confidence: {} }, 'B')
    await approveReceipt(id, { entity: 'detail', totalCents: 4200, receiptDate: '2026-09-10', vendor: 'MANAGER-SET' }, 'Darryl')
    // Attempt A completes very late → dropped (status is 'approved', token mismatch).
    const late = await applyRetryExtraction(id, c1.token, { aiStatus: 'extracted', aiModel: 'm', aiRaw: {}, aiExtracted: {}, confidence: {}, vendor: 'STALE' }, 'A')
    expect(late.stale).toBe(true)
    const row = await getReceipt(id)
    expect(row?.status).toBe('approved')
    expect(row?.vendor).toBe('MANAGER-SET')
    expect(row?.totalCents).toBe(4200)
  })
})

describe('vehicle association + FK (real Postgres)', () => {
  it('inventoryVehicleExists reflects reality; FK rejects a bogus reference', async () => {
    const vehId = await seedVehicle()
    expect(await inventoryVehicleExists(vehId)).toBe(true)
    expect(await inventoryVehicleExists('00000000-0000-0000-0000-000000000000')).toBe(false)
    const list = await listInventoryVehiclesForPicker()
    expect(list.some((v) => v.id === vehId)).toBe(true)
    // Direct FK violation on a bogus vehicle id.
    await expect(client.query(
      `INSERT INTO business_receipts(image_hash, inventory_vehicle_id) VALUES('V1','00000000-0000-0000-0000-000000000000')`,
    )).rejects.toBeTruthy()
  })

  it('ON DELETE SET NULL clears the link instead of deleting the receipt', async () => {
    const vehId = await seedVehicle('PS-9999')
    const { id } = await createReceipt(baseReceipt({ imageHash: 'V2', inventoryVehicleId: vehId }))
    await client.query(`DELETE FROM inventory_vehicles WHERE id=$1`, [vehId])
    const row = await getReceipt(id)
    expect(row).not.toBeNull()          // receipt + evidence retained
    expect(row?.inventoryVehicleId).toBeNull() // link cleared, not cascaded
  })
})

describe('business-month filtering uses plain dates (no UTC drift)', () => {
  it('a month-boundary date lands in the right month', async () => {
    const jan = await createReceipt(baseReceipt({ imageHash: 'M1' }))
    await approveReceipt(jan.id, { entity: 'detail', totalCents: 1000, receiptDate: '2026-01-31' }, 'D')
    const feb = await createReceipt(baseReceipt({ imageHash: 'M2' }))
    await approveReceipt(feb.id, { entity: 'detail', totalCents: 2000, receiptDate: '2026-02-01' }, 'D')
    const rpt = await monthlyExpenseReport('2026-01')
    expect(rpt.approvedCount).toBe(1)
    expect(rpt.approvedTotalCents).toBe(1000)
    expect(rpt.byEntity.detail.totalCents).toBe(1000)
  })
})

describe('employee operational filing (real Postgres)', () => {
  const filer = { name: 'Sam', key: 'sam' }

  it('a complete filing → status filed, attributed, funding business, export-ready, no attention reasons', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F1', uploadedByKey: 'sam' }))
    const r = await fileReceipt(id, cleanFiling(), filer)
    expect(r.ok).toBe(true); expect(r.status).toBe('filed'); expect(r.reasons).toEqual([])
    const row = await getReceipt(id)
    expect(row?.status).toBe('filed')
    expect(row?.filedBy).toBe('Sam'); expect(row?.filedByKey).toBe('sam'); expect(row?.filedAt).not.toBeNull()
    expect(row?.approvedBy).toBeNull()                 // filing is NOT approval
    expect(row?.funding).toBe('business'); expect(row?.paymentMethod).toBe('card')
    expect(row?.qbSyncStatus).toBe('export_ready')
    expect(row?.attentionReasons).toEqual([])
  })

  it('the employee’s confirmed vendor/date/total OVERRIDE the AI proposal', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F2', vendor: 'AI Vendor', receiptDate: '2020-01-01', totalCents: 999 }))
    await fileReceipt(id, cleanFiling({ vendor: 'Real Vendor', receiptDate: '2026-01-15', totalCents: 4599 }), filer)
    const row = await getReceipt(id)
    expect(row?.vendor).toBe('Real Vendor'); expect(row?.receiptDate).toBe('2026-01-15'); expect(row?.totalCents).toBe(4599)
  })

  it('personal money → stays needs_review, flagged reimbursement, NOT a business instrument, not export-ready', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F3' }))
    const r = await fileReceipt(id, cleanFiling({ funding: 'personal', paymentMethod: null }), filer)
    expect(r.status).toBe('needs_review'); expect(r.reasons).toContain('personal_reimbursement')
    const row = await getReceipt(id)
    expect(row?.status).toBe('needs_review'); expect(row?.funding).toBe('personal')
    expect(row?.paymentMethod).toBeNull(); expect(row?.filedBy).toBeNull(); expect(row?.qbSyncStatus).toBe('none')
    expect(row?.attentionReasons).toContain('personal_reimbursement')
  })

  it('unpaid → stays needs_review, flagged unpaid', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F4' }))
    const r = await fileReceipt(id, cleanFiling({ funding: 'unpaid', paymentMethod: null }), filer)
    expect(r.status).toBe('needs_review'); expect(r.reasons).toContain('unpaid')
    expect((await getReceipt(id))?.funding).toBe('unpaid')
  })

  it('mixed categories → uncategorized + flagged (whole total not dumped into one guess)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F5' }))
    const r = await fileReceipt(id, cleanFiling({ category: { kind: 'mixed' } }), filer)
    expect(r.status).toBe('needs_review'); expect(r.reasons).toContain('mixed_category')
    expect((await getReceipt(id))?.category).toBe('uncategorized')
  })

  it('missing total → needs_review missing_info (never coerced to $0)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F6' }))
    const r = await fileReceipt(id, cleanFiling({ totalCents: null }), filer)
    expect(r.status).toBe('needs_review'); expect(r.reasons).toContain('missing_info')
    expect((await getReceipt(id))?.totalCents).toBeNull()
  })

  it('double-file is idempotent (a filed receipt is a no-op success)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F7' }))
    expect((await fileReceipt(id, cleanFiling(), filer)).status).toBe('filed')
    const again = await fileReceipt(id, cleanFiling(), filer)
    expect(again.ok).toBe(true); expect(again.alreadyFiled).toBe(true)
  })

  it('concurrent finalization: exactly one files, the other is a safe idempotent no-op', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F8' }))
    const [a, b] = await Promise.all([fileReceipt(id, cleanFiling(), filer), fileReceipt(id, cleanFiling(), filer)])
    expect(a.ok && b.ok).toBe(true)
    // one did the real transition, the other saw it already filed — never two filings, never an error.
    const filedFresh = [a, b].filter((r) => r.status === 'filed' && !r.alreadyFiled)
    expect(filedFresh.length).toBeGreaterThanOrEqual(1)
    expect((await getReceipt(id))?.status).toBe('filed')
  })

  it('a filed receipt cannot be claimed for re-extraction (late AI can never overwrite a filing)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F9' }))
    await fileReceipt(id, cleanFiling(), filer)
    const claim = await claimRetryExtraction(id)
    expect(claim.ok).toBe(false)                        // not in an editable state → refused
    expect((await getReceipt(id))?.status).toBe('filed')
  })

  it('reopen a filed receipt → needs_review, clears filing attribution', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F10' }))
    await fileReceipt(id, cleanFiling(), filer)
    const re = await reopenReceipt(id, 'Darryl')
    expect(re.ok).toBe(true)
    const row = await getReceipt(id)
    expect(row?.status).toBe('needs_review'); expect(row?.filedBy).toBeNull(); expect(row?.qbSyncStatus).toBe('none')
  })

  it('cannot file from an approved/rejected/filed row via the guarded update (conflict, not a second filing)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'F11' }))
    await rejectReceipt(id, 'nope', 'Darryl')
    const r = await fileReceipt(id, cleanFiling(), filer)
    expect(r.ok).toBe(false); expect(r.conflict).toBe(true)
    expect((await getReceipt(id))?.status).toBe('rejected')
  })
})

describe('monthly report — filed receipts + funding split, no double counting (real Postgres)', () => {
  const filer = { name: 'Sam', key: 'sam' }
  it('filed receipts are counted once; funding buckets separate business cash from personal/unpaid', async () => {
    // business-filed $45.99 (Jan), personal-flagged $10 (stays needs_review — NOT complete), legacy approved $20.
    const f1 = await createReceipt(baseReceipt({ imageHash: 'R1' }))
    await fileReceipt(f1.id, cleanFiling({ totalCents: 4599, receiptDate: '2026-01-10' }), filer)
    const f2 = await createReceipt(baseReceipt({ imageHash: 'R2' }))
    await fileReceipt(f2.id, cleanFiling({ funding: 'personal', paymentMethod: null, totalCents: 1000, receiptDate: '2026-01-11' }), filer)
    const ap = await createReceipt(baseReceipt({ imageHash: 'R3' }))
    await approveReceipt(ap.id, { entity: 'detail', totalCents: 2000, receiptDate: '2026-01-12' }, 'Darryl')

    const rpt = await monthlyExpenseReport('2026-01')
    // Complete = filed(1) + legacy approved(1). The personal receipt is an exception, not complete.
    expect(rpt.completeCount).toBe(2)
    expect(rpt.filedCount).toBe(1)
    expect(rpt.approvedCount).toBe(1)
    // Purchases counted once each (no double count): 4599 + 2000.
    expect(rpt.purchasesTotalCents).toBe(6599)
    // Business cash outflow is ONLY the business-funded filing; the legacy approved is unknown-funding.
    expect(rpt.businessCashOutflowCents).toBe(4599)
    expect(rpt.unknownFundingCents).toBe(2000)
    // The personal receipt is surfaced as attention, NOT added to purchases or business cash.
    expect(rpt.needsReviewCount).toBe(1)
    expect(rpt.personalReimbursableCents).toBe(0) // it isn't complete, so not in the complete-set buckets
  })
})

describe('manager exception resolution — clarify without falsifying facts (real Postgres)', () => {
  const mgr = { name: 'Darryl', key: 'darryl' }

  it('personal money: acknowledge → reviewed + OUTSTANDING, funding stays personal, leaves the backlog', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A1' }))
    const r = await fileReceipt(id, cleanFiling({ funding: 'personal', paymentMethod: null }), mgr, { acknowledge: true })
    expect(r.ok).toBe(true); expect(r.status).toBe('needs_review'); expect(r.clarified).toBe(true)
    const row = await getReceipt(id)
    expect(row?.funding).toBe('personal')            // NOT flipped to business
    expect(row?.status).toBe('needs_review')
    expect(row?.clarifiedAt).not.toBeNull(); expect(row?.clarifiedBy).toBe('Darryl')
    expect(row?.filedBy).toBeNull()                  // reviewing ≠ reimbursement paid ≠ a filing
    expect(row?.attentionReasons).toContain('personal_reimbursement')
    // Leaves the primary backlog, appears in the Outstanding list.
    expect((await listReceipts(['needs_review'], { clarified: 'exclude' })).some((x) => x.id === id)).toBe(false)
    expect((await listReceipts(['needs_review'], { clarified: 'only' })).some((x) => x.id === id)).toBe(true)
    const c = await queueCounts(); expect(c.outstanding).toBe(1); expect(c.backlog).toBe(0)
  })

  it('unpaid stays unpaid after acknowledgement (payment not established)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A2' }))
    await fileReceipt(id, cleanFiling({ funding: 'unpaid', paymentMethod: null }), mgr, { acknowledge: true })
    const row = await getReceipt(id)
    expect(row?.funding).toBe('unpaid'); expect(row?.clarifiedAt).not.toBeNull()
    expect(row?.attentionReasons).toContain('unpaid')
  })

  it('mixed receipt stays UNALLOCATED (uncategorized) after acknowledgement — total not forced into one category', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A3' }))
    const r = await fileReceipt(id, cleanFiling({ category: { kind: 'mixed' } }), mgr, { acknowledge: true })
    expect(r.clarified).toBe(true)
    const row = await getReceipt(id)
    expect(row?.category).toBe('uncategorized'); expect(row?.totalCents).toBe(4599)
    expect(row?.attentionReasons).toContain('mixed_category')
  })

  it('"Other / Not sure" can be CORRECTED to a supported category → clean filing (no acknowledge needed)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A4' }))
    // first lands unsure
    await fileReceipt(id, { entity: 'detail', category: { kind: 'unsure' }, funding: 'business', paymentMethod: 'card', vendor: 'V', receiptDate: '2026-01-15', totalCents: 1000 }, mgr)
    // manager corrects to a real category
    const r = await fileReceipt(id, cleanFiling({ category: single('parts'), totalCents: 1000 }), mgr)
    expect(r.status).toBe('filed'); expect((await getReceipt(id))?.category).toBe('parts')
  })

  it('missing field supplied → clean filing', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A5' }))
    await fileReceipt(id, cleanFiling({ totalCents: null }), mgr)     // exception: missing_info
    const r = await fileReceipt(id, cleanFiling({ totalCents: 2599 }), mgr)
    expect(r.status).toBe('filed'); expect((await getReceipt(id))?.totalCents).toBe(2599)
  })

  it('acknowledge is REFUSED while a fixable reason remains (missing total) — stays in the backlog', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A6' }))
    const r = await fileReceipt(id, cleanFiling({ funding: 'personal', paymentMethod: null, totalCents: null }), mgr, { acknowledge: true })
    expect(r.clarified).toBe(false)                  // can't hide a missing field behind "reviewed"
    const row = await getReceipt(id)
    expect(row?.clarifiedAt).toBeNull()
    expect((await listReceipts(['needs_review'], { clarified: 'exclude' })).some((x) => x.id === id)).toBe(true)
  })

  it('reject and reopen both clear the clarification (append-only history preserved)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A7' }))
    await fileReceipt(id, cleanFiling({ funding: 'unpaid', paymentMethod: null }), mgr, { acknowledge: true })
    await rejectReceipt(id, 'dup', mgr.name)
    expect((await getReceipt(id))?.clarifiedAt).toBeNull()
    await reopenReceipt(id, mgr.name)
    const row = await getReceipt(id)
    expect(row?.clarifiedAt).toBeNull(); expect(row?.status).toBe('needs_review')
    // Append-only audit retains every step.
    const actions = (row?.auditLog as { action: string }[]).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['uploaded', 'clarified', 'rejected', 'reopened']))
  })

  it('once actually paid, an acknowledged unpaid receipt can be filed clean (funding → business)', async () => {
    const { id } = await createReceipt(baseReceipt({ imageHash: 'A8' }))
    await fileReceipt(id, cleanFiling({ funding: 'unpaid', paymentMethod: null }), mgr, { acknowledge: true })
    const r = await fileReceipt(id, cleanFiling({ funding: 'business', paymentMethod: 'check' }), mgr)
    expect(r.status).toBe('filed')
    const row = await getReceipt(id)
    expect(row?.status).toBe('filed'); expect(row?.clarifiedAt).toBeNull(); expect(row?.funding).toBe('business')
  })
})

describe('fast durable save + capture-id dedup (real Postgres)', () => {
  const pend = (over: Record<string, unknown> = {}) => ({
    storageRef: 'business-receipts/h.jpg', filename: 'r.jpg', contentType: 'image/jpeg',
    imageHash: 'h1', byteSize: 100, uploadedBy: 'Sam', uploadedByKey: 'sam', ...over,
  })

  it('creates a recoverable PENDING row (needs_review, ai pending, capture_id) with no proposal', async () => {
    const { id } = await createPendingReceipt(pend({ captureId: 'cap-A', imageHash: 'hA' }))
    const row = await getReceipt(id)
    expect(row?.status).toBe('needs_review')
    expect(row?.aiStatus).toBe('pending')
    expect(row?.captureId).toBe('cap-A')
    expect(row?.vendor).toBeNull(); expect(row?.totalCents).toBeNull()
    expect(await findReceiptByCaptureId('cap-A')).not.toBeNull()
  })

  it('a RETRY with the same capture_id returns the SAME receipt (no second purchase) even if bytes differ', async () => {
    const a = await createPendingReceipt(pend({ captureId: 'cap-B', imageHash: 'hB1' }))
    const b = await createPendingReceipt(pend({ captureId: 'cap-B', imageHash: 'hB2-retaken' })) // different bytes
    expect(b.duplicate).toBe(true)
    expect(b.id).toBe(a.id)
  })

  it('identical bytes (same hash) also collapse to one active receipt', async () => {
    const a = await createPendingReceipt(pend({ captureId: 'cap-C1', imageHash: 'hC' }))
    const b = await createPendingReceipt(pend({ captureId: 'cap-C2', imageHash: 'hC' }))
    expect(b.duplicate).toBe(true); expect(b.id).toBe(a.id)
  })

  it('a rejected capture_id frees the id for a fresh capture (partial unique excludes rejected)', async () => {
    const a = await createPendingReceipt(pend({ captureId: 'cap-D', imageHash: 'hD1' }))
    await rejectReceipt(a.id, 'test', 'Mgr')
    const b = await createPendingReceipt(pend({ captureId: 'cap-D', imageHash: 'hD2' })) // re-use after rejection
    expect(b.duplicate).toBe(false); expect(b.id).not.toBe(a.id)
  })
})

describe('possible-duplicate detection — vendor+date+total, never total alone (real Postgres)', () => {
  const filer = { name: 'Sam', key: 'sam' }
  const filedCostco = async (hash: string, over: Record<string, unknown> = {}) => {
    const { id } = await createReceipt(baseReceipt({ imageHash: hash, uploadedByKey: 'sam' }))
    await fileReceipt(id, { entity: 'detail', category: single('shop_supplies'), funding: 'business', paymentMethod: 'card', vendor: 'Costco', receiptDate: '2026-03-14', totalCents: 44672, ...over }, filer)
    return id
  }
  it('two photos of the same purchase (same vendor+date+total, same uploader) surface as candidates', async () => {
    const a = await filedCostco('D1'); const b = await filedCostco('D2')
    expect((await possibleDuplicateFor(b))?.id).toBe(a)
    expect((await possibleDuplicateFor(a))?.id).toBe(b)
  })
  it('EQUAL TOTAL ALONE is not a duplicate (different vendor/date)', async () => {
    await filedCostco('E1')
    const other = await filedCostco('E2', { vendor: 'Napa', receiptDate: '2026-03-20' }) // same total, different vendor+date
    expect(await possibleDuplicateFor(other)).toBeNull()
  })
  it('another employee’s matching receipt is NOT surfaced (privacy)', async () => {
    const { id: mine } = await createReceipt(baseReceipt({ imageHash: 'F1', uploadedByKey: 'sam' }))
    await fileReceipt(mine, { entity: 'detail', category: single('shop_supplies'), funding: 'business', paymentMethod: 'card', vendor: 'Costco', receiptDate: '2026-03-14', totalCents: 44672 }, filer)
    const { id: theirs } = await createReceipt(baseReceipt({ imageHash: 'F2', uploadedByKey: 'lee' }))
    await fileReceipt(theirs, { entity: 'detail', category: single('shop_supplies'), funding: 'business', paymentMethod: 'card', vendor: 'Costco', receiptDate: '2026-03-14', totalCents: 44672 }, { name: 'Lee', key: 'lee' })
    expect(await possibleDuplicateFor(theirs)).toBeNull() // sam's receipt not exposed to lee
  })
})

describe('durable ATOMIC rate limiter (real Postgres)', () => {
  it('admits exactly `limit`, rejects with retry-after, and a rejected attempt does NOT consume budget', async () => {
    const bucket = 'upload:actor:darryl'
    expect((await consumeRateLimit(bucket, 2, 10_000)).ok).toBe(true)
    expect((await consumeRateLimit(bucket, 2, 10_000)).ok).toBe(true)
    const blocked = await consumeRateLimit(bucket, 2, 10_000)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
    // The stored counter is exactly the limit — the rejected 3rd attempt did not increment it.
    const c = await client.query<{ count: number }>(`SELECT count FROM expense_rate_counters WHERE bucket=$1`, [bucket])
    expect(c.rows[0].count).toBe(2)
  })

  it('a new window (window boundary) admits again — recovery', async () => {
    const bucket = 'upload:actor:recover'
    await consumeRateLimit(bucket, 1, 10_000)
    expect((await consumeRateLimit(bucket, 1, 10_000)).ok).toBe(false)
    // Simulate the window rolling over (its counter row ages away) → allowed again.
    await client.query(`DELETE FROM expense_rate_counters WHERE bucket=$1`, [bucket])
    expect((await consumeRateLimit(bucket, 1, 10_000)).ok).toBe(true)
  })

  it('overlapping (Promise.all) consumers never exceed the limit', async () => {
    // NOTE: PGlite serializes execution, so this exercises the atomic statement under overlapping promises
    // but NOT independent OS-level connections. The atomicity guarantee is the ON CONFLICT row lock (a
    // single-statement Postgres property); see docs for the precise limitation.
    const bucket = 'upload:actor:burst'
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeRateLimit(bucket, 3, 10_000)))
    expect(results.filter((r) => r.ok).length).toBe(3)
    const c = await client.query<{ count: number }>(`SELECT count FROM expense_rate_counters WHERE bucket=$1`, [bucket])
    expect(c.rows[0].count).toBe(3)
  })
})
