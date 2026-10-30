/**
 * QUICK (homepage) sticker printing against a REAL Postgres — in-memory PGlite with the real
 * schema — because every guarantee that matters here is a database guarantee: the request token is
 * the print job's primary key, so idempotency, concurrency, and ownership are enforced by Postgres
 * rather than by a read-then-write that two phones can race.
 *
 * What is pinned down below:
 *   - one accepted request = exactly one print job, forever (a repeat never prints again, including
 *     after the job reached submitted / failed / expired);
 *   - two simultaneous attempts with the same token produce ONE job;
 *   - a token belonging to someone else — or to a CHECK job — is never readable or re-usable;
 *   - no service order, vehicle, or oil_change_stickers row is ever created;
 *   - expiry sweeps started here only ever touch sticker jobs, so apps/checks keeps its ability to
 *     reconcile a stale check job (print_failed + the 'print_expired' event).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { sql } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { queueQuickStickerPrint, quickStickerJobStatus, quickStickerRef } from './quick'
import { waitingStickerJobForOrder } from './queue'
import { StickerValidationError } from './service'

let db: PgliteDatabase<typeof schema>

const TECH = { key: 'tony', name: 'Tony' }
const OTHER = { key: 'darryl', name: 'Darryl' }
const VALUES = { mileage: 187781, intervalMiles: 5000, intervalMonths: 6 }
const REQ = '11111111-1111-4111-8111-111111111111'

const rows = async (q: string) => (await db.execute(sql.raw(q))) as unknown as { rows: Record<string, unknown>[] }
const jobRows = async () => (await rows(`SELECT * FROM print_jobs ORDER BY created_at`)).rows
const countOf = async (table: string) => Number((await rows(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of ['print_jobs', 'print_bridges', 'oil_change_stickers']) await db.execute(sql.raw(`DELETE FROM ${t}`))
})

describe('a quick sticker request', () => {
  it('queues exactly one label job that carries its own provenance and values', async () => {
    const res = await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    expect(res.alreadyQueued).toBe(false)
    expect(res.job.status).toBe('queued')
    expect(res.job.jobId).toBe(REQ) // the token IS the job id

    const [row] = await jobRows()
    expect(row.kind).toBe('sticker')
    expect(row.printer_target).toBe('label')
    expect(row.check_id).toBeNull()
    expect(row.created_by).toBe('Tony')

    const payload = row.payload as Record<string, unknown>
    const quick = payload.quick as Record<string, unknown>
    expect(quick).toMatchObject({ source: 'quick', requestId: REQ, actorKey: 'tony', mileage: 187781, nextMileage: 192781 })
    // Namespaced identifiers — never a fabricated UUID pretending to be an order/sticker row.
    expect(payload.orderId).toBe(`quick:${REQ}`)
    expect(payload.stickerId).toBe(`quick:${REQ}`)
    expect((payload.texts as { value: string }[]).map((t) => t.value)).toContain('192,781 mi')
  })

  it('creates NO job, vehicle, or sticker-history row', async () => {
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    expect(await countOf('service_orders')).toBe(0)
    expect(await countOf('vehicles')).toBe(0)
    expect(await countOf('oil_change_stickers')).toBe(0)
  })

  it('honours manual overrides of both computed values', async () => {
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES, nextMileage: 200000, nextDate: '2027-01-15' }, TECH)
    const payload = (await jobRows())[0].payload as { texts: { value: string }[] }
    const printed = payload.texts.map((t) => t.value)
    expect(printed).toContain('200,000 mi')
    expect(printed).toContain('Jan 15, 2027')
  })

  it('refuses unprintable values before writing anything (shared validation)', async () => {
    for (const bad of [
      { mileage: -1 }, { nextMileage: 187781 }, { nextDate: '2020-01-01' },
      { intervalMiles: 100 }, { intervalMonths: 0 },
    ]) {
      await expect(queueQuickStickerPrint({ requestId: REQ, ...VALUES, ...bad }, TECH)).rejects.toBeInstanceOf(StickerValidationError)
    }
    expect(await jobRows()).toHaveLength(0)
    // Nothing was spent: the same token still works once the values are right.
    expect((await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)).alreadyQueued).toBe(false)
  })

  it('refuses a token that is not a UUID instead of touching the queue', async () => {
    await expect(queueQuickStickerPrint({ requestId: 'quick-1', ...VALUES }, TECH)).rejects.toMatchObject({ code: 'bad_request_id' })
    await expect(quickStickerJobStatus('not-a-uuid', TECH)).rejects.toMatchObject({ code: 'bad_request_id' })
    expect(await jobRows()).toHaveLength(0)
  })
})

describe('one request = one sticker, permanently', () => {
  it('a repeat of the same token returns the original job and never prints again', async () => {
    const first = await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    const again = await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    expect(again.alreadyQueued).toBe(true)
    expect(again.job.jobId).toBe(first.job.jobId)
    expect(await jobRows()).toHaveLength(1)
  })

  it('still a no-op AFTER the job finished — submitted, failed, or expired', async () => {
    for (const status of ['submitted', 'failed', 'expired', 'canceled']) {
      await db.execute(sql.raw(`DELETE FROM print_jobs`))
      await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
      await db.execute(sql`UPDATE print_jobs SET status = ${status} WHERE id = ${REQ}::uuid`)

      const repeat = await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
      expect(repeat.alreadyQueued).toBe(true)
      expect(repeat.job.status).toBe(status)
      expect(await jobRows()).toHaveLength(1) // no second sticker, ever
    }
  })

  it('a repeat with DIFFERENT values cannot rewrite what was already sent', async () => {
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    const repeat = await queueQuickStickerPrint({ requestId: REQ, mileage: 5, intervalMiles: 3000, intervalMonths: 3 }, TECH)
    expect(repeat.alreadyQueued).toBe(true)
    const quick = ((await jobRows())[0].payload as { quick: { mileage: number } }).quick
    expect(quick.mileage).toBe(187781)
    expect(await jobRows()).toHaveLength(1)
  })

  it('two simultaneous attempts with one token produce exactly ONE job', async () => {
    const results = await Promise.all([
      queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH),
      queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH),
    ])
    expect(await jobRows()).toHaveLength(1)
    expect(results.filter((r) => !r.alreadyQueued)).toHaveLength(1)
    expect(new Set(results.map((r) => r.job.jobId)).size).toBe(1)
  })

  it('a NEW token is a deliberate second sticker (reprint), not a duplicate', async () => {
    const other = '22222222-2222-4222-8222-222222222222'
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    const copy = await queueQuickStickerPrint({ requestId: other, ...VALUES }, TECH)
    expect(copy.alreadyQueued).toBe(false)
    expect(await jobRows()).toHaveLength(2)
  })
})

describe('ownership — nobody can read or reuse another actor’s request', () => {
  it('another actor gets "not found", and cannot re-point the token at themselves', async () => {
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    await expect(quickStickerJobStatus(REQ, OTHER)).rejects.toMatchObject({ code: 'job_not_found' })
    await expect(queueQuickStickerPrint({ requestId: REQ, ...VALUES }, OTHER)).rejects.toMatchObject({ code: 'request_id_conflict' })
    expect(await jobRows()).toHaveLength(1)
    // The owner still sees it, unchanged.
    expect((await quickStickerJobStatus(REQ, TECH)).jobId).toBe(REQ)
  })

  it('an id that belongs to a CHECK job is never answered or overwritten', async () => {
    await db.execute(sql`
      INSERT INTO print_jobs (id, check_id, kind, status, payload)
      VALUES (${REQ}::uuid, NULL, 'check', 'queued', '{"fields":[]}'::jsonb)
    `)
    await expect(quickStickerJobStatus(REQ, TECH)).rejects.toMatchObject({ code: 'job_not_found' })
    await expect(queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)).rejects.toMatchObject({ code: 'request_id_conflict' })
    const [row] = await jobRows()
    expect(row.kind).toBe('check') // untouched
    expect(await jobRows()).toHaveLength(1)
  })

  it('an ORDER sticker job is not reachable through the quick path, and vice versa', async () => {
    const orderId = '33333333-3333-4333-8333-333333333333'
    await db.execute(sql`
      INSERT INTO print_jobs (id, check_id, kind, status, payload)
      VALUES (${REQ}::uuid, NULL, 'sticker', 'queued',
              ${JSON.stringify({ kind: 'oil_sticker', stickerId: 'S1', orderId })}::jsonb)
    `)
    await expect(quickStickerJobStatus(REQ, TECH)).rejects.toMatchObject({ code: 'job_not_found' })

    // And a quick sticker never shows up in an order's waiting-job lookup (namespaced orderId).
    await db.execute(sql.raw(`DELETE FROM print_jobs`))
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    expect(await waitingStickerJobForOrder(orderId)).toBeNull()
    expect(await waitingStickerJobForOrder(quickStickerRef(REQ))).not.toBeNull()
  })
})

describe('status reporting', () => {
  it('reflects expiry before answering, so a stale "queued" never looks live', async () => {
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    await db.execute(sql`UPDATE print_jobs SET created_at = now() - interval '30 minutes' WHERE id = ${REQ}::uuid`)
    const view = await quickStickerJobStatus(REQ, TECH)
    expect(view.status).toBe('expired')
    expect(view.error).toContain('expired without printing')
  })

  it('flags a long-silent claimed job as uncertain instead of implying success', async () => {
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    await db.execute(sql`UPDATE print_jobs SET status = 'claimed', claimed_at = now() - interval '10 minutes' WHERE id = ${REQ}::uuid`)
    expect(await quickStickerJobStatus(REQ, TECH)).toMatchObject({ status: 'claimed', uncertain: true })
  })

  it('an unknown token is "not found" — not an error the UI could mistake for a failed print', async () => {
    await expect(quickStickerJobStatus(REQ, TECH)).rejects.toMatchObject({ code: 'job_not_found' })
  })
})

describe('the shared queue stays safe for checks', () => {
  /** Expiring a job CONSUMES it: if the quick path swept a stale CHECK job, apps/checks could no
   *  longer mark the check print_failed or record its 'print_expired' event. */
  it('quick-print expiry sweeps never touch a stale check job', async () => {
    await db.execute(sql`
      INSERT INTO print_jobs (check_id, kind, status, payload, created_at)
      VALUES (NULL, 'check', 'queued', '{"fields":[]}'::jsonb, now() - interval '30 minutes')
    `)
    await queueQuickStickerPrint({ requestId: REQ, ...VALUES }, TECH)
    await quickStickerJobStatus(REQ, TECH).catch(() => {})

    const check = (await jobRows()).find((r) => r.kind === 'check')!
    expect(check.status).toBe('queued') // still the checks module's to reconcile
    expect(check.error).toBeNull()
  })
})
