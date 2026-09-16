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
  listInventoryVehiclesForPicker, monthlyExpenseReport, consumeRateLimit,
} from './db'

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
  // Idempotency: re-apply must not throw.
  await applyMigration(client, '0038_business_receipts.sql')
  await applyMigration(client, '0039_business_receipts_dedup.sql')
  await applyMigration(client, '0040_business_receipts_hardening.sql')
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
