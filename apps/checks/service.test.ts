import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

/**
 * Exercises the check state machine against a REAL Postgres (PGlite, in-process) built from the actual
 * migrations (0032 + 0050 + 0055) — so the SQL that guards money and paper (number reservation, the QuickBooks
 * write lock, one-active-print-job, compare-and-set job transitions, queue expiry, heartbeat) is what runs.
 * Only the outside world is faked: QuickBooks (vendor / Purchase calls / connection) and config.
 * No network, no production database.
 */
vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const h = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  token: { realmId: 'REALM-PROD', accessToken: 'x', environment: 'production' as string },
  resolvePayee: vi.fn(), createCheckInQB: vi.fn(), findChecksByDocNumber: vi.fn(),
}))
vi.mock('./config', () => ({
  getCheckConfig: vi.fn(async () => h.cfg),
  bankForCategory: (cfg: { banks: Record<string, unknown> }, cat: string) => cfg.banks[cat === 'auto_sales' ? 'auto_sales' : 'operating'],
  checkConfigReadiness: () => ({ ready: true, enabled: true, operatingBankConfigured: true, autoSalesBankConfigured: true, missingCategoryAccounts: [] }),
}))
vi.mock('./payee', async (orig) => ({ ...(await orig<typeof import('./payee')>()), resolvePayee: h.resolvePayee }))
vi.mock('./qb-check', async (orig) => ({ ...(await orig<typeof import('./qb-check')>()), createCheckInQB: h.createCheckInQB, findChecksByDocNumber: h.findChecksByDocNumber }))
vi.mock('@/apps/quickbooks/connection', () => ({ getValidAccessToken: vi.fn(async () => h.token) }))

import { getDb } from '@/platform/db'
import { DEFAULT_LAYOUT } from './layout'
import {
  createAndRecordCheck, retryQbWrite, queueCheckPrint, recordPrintResult, applyBridgeResult, resolvePrintJob,
  enqueueTestPrint, enqueueBankSpecimen, renderClaimedJob, reconcileExpiredJobs, assertCheckRealm, qbRequestId, CheckValidationError,
} from './service'
import { claimNextJob, getJob, enqueuePrintJob, recordBridgeHeartbeat, getBridgeStatus, jobsForCheck, PRINT_JOB_TTL_MINUTES } from './print-queue'
import { getCheckRow, acquireQbWriteLock, checkEventHistory } from './db'
import { PayeeLookupError, PayeeExistsError, PayeeBlockedError, PayeeNotFoundError, AmbiguousPayeeError } from './payee'
import { initCheckSequence, peekNextNumber } from './numbering'

const pg = new PGlite()
const migration = (f: string) => readFileSync(join(process.cwd(), 'drizzle', 'migrations', 'manual', f), 'utf8')
const actor = { key: 'torlan', name: 'Torlan' }
const ROUTING = '021000021', ACCOUNT = '1234567'
const savedEnv = { r: process.env.MICR_ROUTING, a: process.env.MICR_ACCOUNT, s: process.env.CHECKS_ALLOW_SANDBOX_QB }
let key = 0
const input = (over: Record<string, unknown> = {}) => ({ payeeName: 'Thompson Derrig', amountCents: 150034, memo: 'parts', category: 'shop_general' as const, idempotencyKey: 'k' + (++key), ...over })
const qbRow = (over: Record<string, unknown> = {}) => ({ purchaseId: 'P1', docNumber: '20000', syncToken: '0', totalCents: 150034, bankAccountId: '31', vendorId: 'V1', txnDate: '2026-10-12', ...over })

beforeAll(async () => {
  await pg.exec(migration('0032_checks.sql'))
  await pg.exec(migration('0050_check_print_safety.sql'))
  await pg.exec(migration('0055_check_payee_entity_type.sql'))
  // app_settings exactly as migration 0016 creates it (the bank-specimen slot lives there)
  await pg.exec(/CREATE TABLE IF NOT EXISTS app_settings \([\s\S]*?\n\);/.exec(migration('0016_fees_and_settings.sql'))![0])
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(async () => {
  for (const [k, v] of [['MICR_ROUTING', savedEnv.r], ['MICR_ACCOUNT', savedEnv.a], ['CHECKS_ALLOW_SANDBOX_QB', savedEnv.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await pg.close()
})
beforeEach(async () => {
  await pg.exec('TRUNCATE print_jobs, check_events, checks, check_sequence, print_bridges, app_settings CASCADE')
  await initCheckSequence('operating', 20000, 'test')
  await initCheckSequence('auto_sales', 500, 'test')
  process.env.MICR_ROUTING = ROUTING; process.env.MICR_ACCOUNT = ACCOUNT; delete process.env.CHECKS_ALLOW_SANDBOX_QB
  h.token = { realmId: 'REALM-PROD', accessToken: 'x', environment: 'production' }
  h.cfg = {
    enabled: true, liveEnabled: true, qboRealmId: 'REALM-PROD', templateMode: 'blank_full', micrEnabled: true,
    banks: { operating: { key: 'operating', qboAccountId: '31', label: 'Op' }, auto_sales: { key: 'auto_sales', qboAccountId: '48', label: 'AS' } },
    categoryAccounts: { shop_general: '51', customer_job: '16', equipment: '112', owner_personal: '21', other: '20', auto_sales: '88' },
    layout: DEFAULT_LAYOUT, display: { companyName: 'Pitt Stop', companyAddr: null, companyPhone: null, bankName: 'AMB', bankAddr: null },
  }
  h.resolvePayee.mockReset().mockResolvedValue({ id: 'V1', type: 'Vendor', displayName: 'Thompson Derrig', active: true })
  h.findChecksByDocNumber.mockReset().mockResolvedValue([])
  h.createCheckInQB.mockReset().mockImplementation(async (p: Record<string, unknown>) => qbRow({ docNumber: p.docNumber, totalCents: p.amountCents, bankAccountId: p.bankAccountId, vendorId: p.vendorId, payeeType: p.payeeType, txnDate: p.txnDate }))
})

const expectCode = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toMatchObject({ code }); await expect(p).rejects.toBeInstanceOf(CheckValidationError) }
async function recorded(over: Record<string, unknown> = {}) { const r = await createAndRecordCheck(input(over), actor); expect(r.recorded).toBe(true); return r.check }
/** Send a check to the printer and have the bridge claim it. */
async function sentAndClaimed(checkId: string, reprint = false) { const { jobId } = await queueCheckPrint(checkId, actor, { reprint }); const job = await claimNextJob('LAPTOP'); expect(job!.id).toBe(jobId); return jobId }
const events = async (id: string) => (await checkEventHistory(id)).map((e) => e.action)

describe('record path', () => {
  it('records the check in QuickBooks exactly once, with the reserved number and a Central-time date', async () => {
    const c = await recorded()
    expect(c.checkNumber).toBe(20000)
    expect(c.qbStatus).toBe('recorded')
    expect(c.checkDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(h.createCheckInQB).toHaveBeenCalledTimes(1)
    expect(h.createCheckInQB.mock.calls[0][0]).toMatchObject({ bankAccountId: '31', expenseAccountId: '51', vendorId: 'V1', docNumber: '20000', amountCents: 150034 })
    expect(h.createCheckInQB.mock.calls[0][0].requestId).toMatch(/^[0-9a-f]{40}$/)
    expect(await peekNextNumber('operating')).toBe(20001)
    expect((await getCheckRow(c.id))!.realmId).toBe('REALM-PROD')
  })

  it('rejects a non-positive amount before any side effect', async () => {
    await expectCode(createAndRecordCheck(input({ amountCents: 0 }), actor), 'amount_invalid')
    expect(await peekNextNumber('operating')).toBe(20000)
    expect(h.resolvePayee).not.toHaveBeenCalled()
  })

  it('is idempotent: a replay with the same idempotencyKey never writes QuickBooks or takes a number twice', async () => {
    const i = input()
    const a = await createAndRecordCheck(i, actor)
    const b = await createAndRecordCheck(i, actor)
    expect(b.check.id).toBe(a.check.id)
    expect(h.createCheckInQB).toHaveBeenCalledTimes(1)
    expect(await peekNextNumber('operating')).toBe(20001)
  })

  it('routes Auto Sales checks to the Auto Sales bank + its own number sequence (operating untouched)', async () => {
    const c = await recorded({ category: 'auto_sales' })
    expect(c.bankKey).toBe('auto_sales'); expect(c.checkNumber).toBe(500)
    expect(h.createCheckInQB.mock.calls[0][0]).toMatchObject({ bankAccountId: '48', expenseAccountId: '88' })
    expect(await peekNextNumber('operating')).toBe(20000)
  })
})

describe('payee resolution — Vendors, Employees and Customers; nothing is spent on a payee problem', () => {
  const ANTHONY = { id: '400000021', type: 'Employee', displayName: 'Anthony Pittman', active: true }

  it('pays an existing EMPLOYEE: persists the entity type and sends it to QuickBooks as the Employee', async () => {
    h.resolvePayee.mockResolvedValue(ANTHONY)
    const c = await recorded({ payeeName: 'anthony  pittman', amountCents: 100612, memo: 'Payroll' })
    expect(h.resolvePayee).toHaveBeenCalledWith('anthony  pittman', { payeeId: null, payeeType: null, allowCreate: false })
    expect(h.createCheckInQB.mock.calls[0][0]).toMatchObject({ vendorId: '400000021', payeeType: 'Employee', amountCents: 100612 })
    const row = (await getCheckRow(c.id))!
    expect(row).toMatchObject({ payeeName: 'Anthony Pittman', payeeQboVendorId: '400000021', payeeQboEntityType: 'Employee', checkNumber: 20000 })
  })

  it('passes an explicit pick (id + type) through to the resolver', async () => {
    h.resolvePayee.mockResolvedValue(ANTHONY)
    await recorded({ payeeName: 'Anthony Pittman', vendorId: '400000021', payeeType: 'Employee' })
    expect(h.resolvePayee).toHaveBeenCalledWith('Anthony Pittman', { payeeId: '400000021', payeeType: 'Employee', allowCreate: false })
  })

  it('rejects an unknown payee type before any side effect', async () => {
    await expectCode(createAndRecordCheck(input({ payeeType: 'OtherName' }), actor), 'payee_type_invalid')
    expect(h.resolvePayee).not.toHaveBeenCalled()
  })

  it.each([
    ['the QuickBooks lookup failed', new PayeeLookupError(new Error('503'))],
    ['6240: the name already exists (re-confirm the existing payee)', new PayeeExistsError(ANTHONY as never)],
    ['the name belongs to an inactive record', new PayeeBlockedError('inactive', [])],
    ['a brand-new payee was not confirmed', new PayeeNotFoundError('Brand New LLC')],
    ['the name is ambiguous', new AmbiguousPayeeError([])],
  ])('when %s: no check row, no QuickBooks write, and the check number is NOT used', async (_l, err) => {
    h.resolvePayee.mockRejectedValue(err)
    const i = input()
    await expect(createAndRecordCheck(i, actor)).rejects.toBe(err)
    expect(h.createCheckInQB).not.toHaveBeenCalled()
    expect(await peekNextNumber('operating')).toBe(20000)
    // The same confirmation (same idempotency key) then succeeds with the SAME next number — exactly one check.
    h.resolvePayee.mockResolvedValue(ANTHONY)
    const ok = await createAndRecordCheck(i, actor)
    expect(ok.recorded).toBe(true); expect(ok.check.checkNumber).toBe(20000)
    expect(h.createCheckInQB).toHaveBeenCalledTimes(1)
    expect(await peekNextNumber('operating')).toBe(20001)
  })

  it('a retry after a QuickBooks failure re-sends the stored EMPLOYEE type with the same number (no payee lookup)', async () => {
    h.resolvePayee.mockResolvedValue(ANTHONY)
    h.createCheckInQB.mockRejectedValueOnce(new Error('QuickBooks API /purchase failed (500)'))
    const first = await createAndRecordCheck(input(), actor)
    expect(first.recorded).toBe(false)
    h.resolvePayee.mockClear()
    expect((await retryQbWrite(first.check.id, actor)).recorded).toBe(true)
    expect(h.resolvePayee).not.toHaveBeenCalled()
    expect(h.createCheckInQB.mock.calls[1][0]).toMatchObject({ vendorId: '400000021', payeeType: 'Employee', docNumber: '20000' })
    expect(h.createCheckInQB.mock.calls[1][0].requestId).toBe(h.createCheckInQB.mock.calls[0][0].requestId)
    expect(await peekNextNumber('operating')).toBe(20001)
  })

  it('a double-tapped Record & Print (same key, at the same time) writes ONE check', async () => {
    h.resolvePayee.mockResolvedValue(ANTHONY)
    const i = input()
    const [a, b] = await Promise.all([createAndRecordCheck(i, actor), createAndRecordCheck(i, actor)])
    expect(a.check.id).toBe(b.check.id)
    expect(h.createCheckInQB).toHaveBeenCalledTimes(1)
    expect(await peekNextNumber('operating')).toBe(20001)
  })

  it('crash recovery for an employee check adopts only a Purchase paid to that same Employee', async () => {
    h.resolvePayee.mockResolvedValue(ANTHONY)
    const lost = qbRow({ purchaseId: 'P-LOST', docNumber: '20000', vendorId: '400000021', payeeType: 'Employee', txnDate: '2026-10-16' })
    h.findChecksByDocNumber.mockResolvedValue([lost])
    const c = await createAndRecordCheck(input({ checkDate: '2026-10-16' }), actor)
    expect(c.recorded).toBe(true)
    expect((await getCheckRow(c.check.id))!.qboTxnId).toBe('P-LOST')
    expect(h.createCheckInQB).not.toHaveBeenCalled()
  })

  it('…and REFUSES a Purchase with the same id on a different QuickBooks list (vendor 400000021 ≠ employee 400000021)', async () => {
    h.resolvePayee.mockResolvedValue(ANTHONY)
    h.findChecksByDocNumber.mockResolvedValue([qbRow({ docNumber: '20000', vendorId: '400000021', payeeType: 'Vendor', txnDate: '2026-10-16' })])
    const c = await createAndRecordCheck(input({ checkDate: '2026-10-16' }), actor)
    expect(c.recorded).toBe(false)
    expect(h.createCheckInQB).not.toHaveBeenCalled()
  })
})

describe('go-live gates — nothing real happens until everything is in place', () => {
  const nothingHappened = async () => {
    expect(h.createCheckInQB).not.toHaveBeenCalled()
    expect(h.resolvePayee).not.toHaveBeenCalled()       // no vendor could have been created either
    expect(await peekNextNumber('operating')).toBe(20000) // no number consumed
  }
  it('refuses when live recording is off', async () => {
    h.cfg.liveEnabled = false
    await expectCode(createAndRecordCheck(input(), actor), 'live_not_enabled'); await nothingHappened()
  })
  it('refuses when the MICR switch is off (blank stock) — no expense recorded for an unprintable check', async () => {
    h.cfg.micrEnabled = false
    await expectCode(createAndRecordCheck(input(), actor), 'micr_not_ready'); await nothingHappened()
  })
  it('refuses when the bank numbers are not configured', async () => {
    delete process.env.MICR_ROUTING
    await expectCode(createAndRecordCheck(input(), actor), 'micr_not_ready'); await nothingHappened()
  })
  it('refuses a non-production QuickBooks connection', async () => {
    h.token = { realmId: 'REALM-PROD', accessToken: 'x', environment: 'sandbox' }
    await expectCode(createAndRecordCheck(input(), actor), 'qb_not_production'); await nothingHappened()
  })
  it('refuses a QuickBooks company other than the one pinned at go-live', async () => {
    h.token = { realmId: 'SOME-OTHER-COMPANY', accessToken: 'x', environment: 'production' }
    await expectCode(createAndRecordCheck(input(), actor), 'realm_mismatch'); await nothingHappened()
  })
  it('refuses when no company has been pinned', async () => {
    h.cfg.qboRealmId = ''
    await expectCode(createAndRecordCheck(input(), actor), 'realm_not_pinned'); await nothingHappened()
  })
  it('the sandbox override lifts only the environment check, never the company pin', async () => {
    process.env.CHECKS_ALLOW_SANDBOX_QB = '1'
    h.token = { realmId: 'REALM-PROD', accessToken: 'x', environment: 'sandbox' }
    expect(await assertCheckRealm({ qboRealmId: 'REALM-PROD' })).toBe('REALM-PROD')
    await expectCode(assertCheckRealm({ qboRealmId: 'OTHER' }), 'realm_mismatch')
  })
})

describe('QuickBooks failure, retry, and crash recovery', () => {
  it('a failed write is marked failed, keeps its number, and can never be printed', async () => {
    h.createCheckInQB.mockRejectedValueOnce(new Error('QB 500'))
    const r = await createAndRecordCheck(input(), actor)
    expect(r.recorded).toBe(false); expect(r.check.qbStatus).toBe('failed'); expect(r.check.checkNumber).toBe(20000)
    await expectCode(queueCheckPrint(r.check.id, actor), 'not_recorded')
    await expectCode(recordPrintResult(r.check.id, true, actor), 'not_recorded')
    expect(await jobsForCheck(r.check.id)).toHaveLength(0)
  })

  it('retry after a failure records with the SAME number and the SAME request id', async () => {
    h.createCheckInQB.mockRejectedValueOnce(new Error('timeout'))
    const r = await createAndRecordCheck(input(), actor)
    const again = await retryQbWrite(r.check.id, actor)
    expect(again.recorded).toBe(true)
    expect(h.createCheckInQB).toHaveBeenCalledTimes(2)
    expect(h.createCheckInQB.mock.calls[1][0].docNumber).toBe('20000')
    expect(h.createCheckInQB.mock.calls[1][0].requestId).toBe(h.createCheckInQB.mock.calls[0][0].requestId) // QB dedupes the replay
    expect(await peekNextNumber('operating')).toBe(20001)
  })

  it('retry on an already-recorded check does not call QuickBooks at all', async () => {
    const c = await recorded()
    h.createCheckInQB.mockClear(); h.findChecksByDocNumber.mockClear()
    expect((await retryQbWrite(c.id, actor)).recorded).toBe(true)
    expect(h.createCheckInQB).not.toHaveBeenCalled(); expect(h.findChecksByDocNumber).not.toHaveBeenCalled()
  })

  it('CONCURRENT retries: only the lock holder talks to QuickBooks — one Purchase, not two', async () => {
    h.createCheckInQB.mockRejectedValueOnce(new Error('timeout'))
    const r = await createAndRecordCheck(input(), actor)
    h.createCheckInQB.mockClear()
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    h.createCheckInQB.mockImplementationOnce(async (p: Record<string, unknown>) => { await gate; return qbRow({ docNumber: p.docNumber, txnDate: p.txnDate }) })
    const first = retryQbWrite(r.check.id, actor)
    await vi.waitFor(() => expect(h.createCheckInQB).toHaveBeenCalledTimes(1), { timeout: 15000 }) // first is now inside QuickBooks
    const second = await retryQbWrite(r.check.id, actor)                        // arrives mid-write
    expect(second.recorded).toBe(false); expect(second.error).toMatch(/already in progress/)
    release()
    expect((await first).recorded).toBe(true)
    expect(h.createCheckInQB).toHaveBeenCalledTimes(1)
  })

  it('the write lock is exclusive, and a lock abandoned by a crash can be re-taken only once stale', async () => {
    h.createCheckInQB.mockRejectedValueOnce(new Error('x'))
    const { check } = await createAndRecordCheck(input(), actor)
    expect(await acquireQbWriteLock(check.id)).toBe(true)
    expect(await acquireQbWriteLock(check.id)).toBe(false)                     // held
    await pg.query(`UPDATE checks SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [check.id])
    expect(await acquireQbWriteLock(check.id)).toBe(true)                      // stale → recoverable
  })

  it('crash recovery ADOPTS the Purchase a lost attempt created — only on an exact match', async () => {
    h.createCheckInQB.mockRejectedValueOnce(new Error('connection reset'))     // QB actually created it
    const r = await createAndRecordCheck(input(), actor)
    h.createCheckInQB.mockClear()
    h.findChecksByDocNumber.mockResolvedValueOnce([qbRow({ purchaseId: 'P-LOST', txnDate: r.check.checkDate })])
    expect((await retryQbWrite(r.check.id, actor)).recorded).toBe(true)
    expect(h.createCheckInQB).not.toHaveBeenCalled()
    expect((await getCheckRow(r.check.id))!.qboTxnId).toBe('P-LOST')
    expect(await events(r.check.id)).toContain('recorded_adopted')
  })

  it('REFUSES to adopt or create when QuickBooks holds a DIFFERENT check with that number on this bank', async () => {
    h.findChecksByDocNumber.mockResolvedValue([qbRow({ purchaseId: 'P-OLD', totalCents: 999, vendorId: 'V-ELSE', txnDate: '2019-03-01' })])
    const r = await createAndRecordCheck(input(), actor)
    expect(r.recorded).toBe(false); expect(r.error).toMatch(/NOT recorded/)
    expect(h.createCheckInQB).not.toHaveBeenCalled()
    expect((await getCheckRow(r.check.id))!.qboTxnId).toBeNull()
    await expectCode(queueCheckPrint(r.check.id, actor), 'not_recorded')
  })

  it('the request id is stable per check and changes with the content', () => {
    const a = { bankAccountId: '31', expenseAccountId: '51', vendorId: 'V1', amountCents: 100, docNumber: '20000', txnDate: '2026-10-12' }
    expect(qbRequestId('c1', a)).toBe(qbRequestId('c1', a))
    expect(qbRequestId('c1', a)).not.toBe(qbRequestId('c2', a))
    expect(qbRequestId('c1', a)).not.toBe(qbRequestId('c1', { ...a, amountCents: 101 }))
  })
})

describe('duplicate-print prevention', () => {
  it('re-sending a failed print never creates or alters a QuickBooks transaction', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)
    await applyBridgeResult(jobId, 'failed', 'paper jam')
    await sentAndClaimed(c.id)
    expect(h.createCheckInQB).toHaveBeenCalledTimes(1)
    expect(h.resolvePayee).toHaveBeenCalledTimes(1)
    expect(await peekNextNumber('operating')).toBe(20001)
  })
  it('a second send while one is open is refused — exactly one job exists', async () => {
    const c = await recorded()
    await queueCheckPrint(c.id, actor)
    await expectCode(queueCheckPrint(c.id, actor), 'print_in_progress')
    await expectCode(queueCheckPrint(c.id, actor, { reprint: true }), 'print_in_progress')
    expect(await jobsForCheck(c.id)).toHaveLength(1)
  })

  it('the DATABASE refuses a second active job even if two requests race past the app check', async () => {
    const c = await recorded()
    const payload = { pageWidthIn: 8.5, pageHeightIn: 11, fields: [] }
    const [a, b] = await Promise.all([enqueuePrintJob({ checkId: c.id, payload }), enqueuePrintJob({ checkId: c.id, payload })])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    await expect(pg.query(`INSERT INTO print_jobs (check_id, payload) VALUES ($1, '{}')`, [c.id])).rejects.toThrow(/print_jobs_one_active_per_check/)
  })

  it('still refused while printing and while awaiting confirmation', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)
    await expectCode(queueCheckPrint(c.id, actor), 'print_in_progress')            // at the printer
    await applyBridgeResult(jobId, 'submitted', null)
    await expectCode(queueCheckPrint(c.id, actor), 'print_in_progress')            // awaiting confirmation
  })

  it('"No, it didn\'t come out" does NOT allow another copy — the original may still print', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)
    await applyBridgeResult(jobId, 'submitted', null)                              // e.g. spooled to an offline printer
    await resolvePrintJob(c.id, jobId, 'not_printed', actor)
    expect((await getJob(jobId))!.status).toBe('stuck')
    await expectCode(queueCheckPrint(c.id, actor), 'print_in_progress')            // normal send refused
    await expectCode(queueCheckPrint(c.id, actor, { reprint: true }), 'print_in_progress') // reprint refused too
    await expect(pg.query(`INSERT INTO print_jobs (check_id, payload) VALUES ($1, '{}')`, [c.id])).rejects.toThrow(/print_jobs_one_active_per_check/) // and by the database
    await expectCode(resolvePrintJob(c.id, jobId, 'not_printed', actor), 'job_already_resolved') // tapping "No" again changes nothing
    expect(await jobsForCheck(c.id)).toHaveLength(1)
    expect((await getCheckRow(c.id))!.printStatus).toBe('submitted')               // still awaiting a real answer
  })

  it('a resend is possible only after the original is confirmed cleared', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)
    await applyBridgeResult(jobId, 'submitted', null)
    await expectCode(resolvePrintJob(c.id, jobId, 'cleared', actor), 'job_already_resolved') // cannot skip straight to "cleared"
    await resolvePrintJob(c.id, jobId, 'not_printed', actor)
    await resolvePrintJob(c.id, jobId, 'cleared', actor)
    expect((await getJob(jobId))!.status).toBe('failed')
    expect((await getCheckRow(c.id))!.printStatus).toBe('print_failed')
    expect(await events(c.id)).toEqual(expect.arrayContaining(['print_not_confirmed', 'print_original_cleared']))
    await expect(queueCheckPrint(c.id, actor)).resolves.toHaveProperty('jobId')    // deliberate resend
    expect(h.createCheckInQB).toHaveBeenCalledTimes(1)
  })

  it('if the "missing" original prints late, it is settled as printed — still exactly one check', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)
    await applyBridgeResult(jobId, 'submitted', null)
    await resolvePrintJob(c.id, jobId, 'not_printed', actor)
    const v = await resolvePrintJob(c.id, jobId, 'printed', actor)                  // paper was loaded; it came out
    expect(v.printStatus).toBe('printed')
    await expectCode(queueCheckPrint(c.id, actor), 'already_printed')
    expect(await jobsForCheck(c.id)).toHaveLength(1)
  })

  it('once confirmed printed, another copy requires an explicit reprint', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)
    await applyBridgeResult(jobId, 'submitted', null)
    await resolvePrintJob(c.id, jobId, 'printed', actor)
    await expectCode(queueCheckPrint(c.id, actor), 'already_printed')
    const re = await queueCheckPrint(c.id, actor, { reprint: true })
    expect((await getJob(re.jobId))!.kind).toBe('reprint')
    expect(h.createCheckInQB).toHaveBeenCalledTimes(1)                              // printing never writes QuickBooks
  })

  it('each queued job is claimed by exactly one bridge', async () => {
    const c = await recorded()
    await queueCheckPrint(c.id, actor)
    const [a, b] = await Promise.all([claimNextJob('A'), claimNextJob('B')])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })
})

describe('uncertain print outcomes — "sent to the printer" is not "printed"', () => {
  it('a bridge "submitted" report leaves the check awaiting confirmation, not printed', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)
    await applyBridgeResult(jobId, 'submitted', null)
    expect((await getJob(jobId))!.status).toBe('submitted')
    const row = (await getCheckRow(c.id))!
    expect(row.printStatus).toBe('submitted'); expect(row.printedAt).toBeNull()
  })

  it('a manager confirmation is what marks it printed', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)
    await applyBridgeResult(jobId, 'submitted', null)
    const v = await resolvePrintJob(c.id, jobId, 'printed', actor)
    expect(v.printStatus).toBe('printed'); expect(v.printedAt).not.toBeNull()
    expect((await getJob(jobId))!.status).toBe('printed')
    expect(await events(c.id)).toEqual(expect.arrayContaining(['print_queued', 'print_submitted', 'print_confirmed', 'printed']))
  })

  it('a duplicate or late bridge report changes nothing (no double count, no revival)', async () => {
    const c = await recorded()
    const j1 = await sentAndClaimed(c.id)
    await applyBridgeResult(j1, 'submitted', null); await resolvePrintJob(c.id, j1, 'printed', actor)
    const j2 = await sentAndClaimed(c.id, true)
    expect((await applyBridgeResult(j2, 'submitted', null)).applied).toBe(true)
    expect((await applyBridgeResult(j2, 'submitted', null)).applied).toBe(false)   // retried report
    await resolvePrintJob(c.id, j2, 'printed', actor)
    expect((await applyBridgeResult(j2, 'failed', 'late')).applied).toBe(false)    // late contradictory report
    const row = (await getCheckRow(c.id))!
    expect(row.reprintCount).toBe(1); expect(row.printStatus).toBe('printed')
    await expectCode(resolvePrintJob(c.id, j2, 'not_printed', actor), 'job_already_resolved')
  })

  it('a bridge failure lets the check be re-sent; a failed REPRINT never un-prints the original', async () => {
    const c = await recorded()
    const j1 = await sentAndClaimed(c.id)
    await applyBridgeResult(j1, 'failed', 'printer offline')
    expect((await getCheckRow(c.id))!.printStatus).toBe('print_failed')
    const j2 = await sentAndClaimed(c.id)
    await applyBridgeResult(j2, 'submitted', null); await resolvePrintJob(c.id, j2, 'printed', actor)
    const j3 = await sentAndClaimed(c.id, true)
    await applyBridgeResult(j3, 'failed', 'jam')
    expect((await getCheckRow(c.id))!.printStatus).toBe('printed')
  })

  it('a job the bridge never reported on stays open, blocks a resend, and is settled by a manager once stale', async () => {
    const c = await recorded()
    const jobId = await sentAndClaimed(c.id)                                        // …then the bridge goes silent
    await expectCode(resolvePrintJob(c.id, jobId, 'not_printed', actor), 'print_in_progress') // too early to call it
    await expectCode(resolvePrintJob(c.id, jobId, 'cleared', actor), 'job_already_resolved')  // and cannot be force-cleared
    await pg.query(`UPDATE print_jobs SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [jobId])
    await expectCode(queueCheckPrint(c.id, actor), 'print_in_progress')            // never auto-requeued
    await applyBridgeResult(jobId, 'uncertain', 'stuck in the Windows print queue')
    expect((await getJob(jobId))!.status).toBe('claimed')
    const v = await resolvePrintJob(c.id, jobId, 'printed', actor)                  // the paper did come out
    expect(v.printStatus).toBe('printed')
  })

  it('a queued job can be canceled before the bridge takes it; a claimed one cannot', async () => {
    const c = await recorded()
    const { jobId } = await queueCheckPrint(c.id, actor)
    await resolvePrintJob(c.id, jobId, 'cancel', actor)
    expect((await getJob(jobId))!.status).toBe('canceled')
    expect(await claimNextJob('LAPTOP')).toBeNull()
    const j2 = await sentAndClaimed(c.id)
    await expectCode(resolvePrintJob(c.id, j2, 'cancel', actor), 'job_already_resolved')
  })

  it('a job id from another check is rejected', async () => {
    const a = await recorded(); const b = await recorded()
    const { jobId } = await queueCheckPrint(a.id, actor)
    await expectCode(resolvePrintJob(b.id, jobId, 'printed', actor), 'job_not_found')
  })

  it('a browser printout can never be recorded as the printed check on blank stock', async () => {
    const c = await recorded()
    await expectCode(recordPrintResult(c.id, true, actor), 'browser_print_not_negotiable')
  })
})

describe('queue expiry — nothing prints late and unattended', () => {
  it('a job the bridge did not take in time is expired, is never claimed, and frees the check to be re-sent', async () => {
    const c = await recorded()
    const { jobId } = await queueCheckPrint(c.id, actor)
    await pg.query(`UPDATE print_jobs SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [jobId, PRINT_JOB_TTL_MINUTES + 1])
    expect(await claimNextJob('LAPTOP')).toBeNull()                                 // even before the sweep runs
    expect(await reconcileExpiredJobs()).toBe(1)
    expect((await getJob(jobId))!.status).toBe('expired')
    expect((await getCheckRow(c.id))!.printStatus).toBe('print_failed')
    expect(await events(c.id)).toContain('print_expired')
    await expect(queueCheckPrint(c.id, actor)).resolves.toHaveProperty('jobId')
  })
  it('a fresh job is not expired', async () => {
    const c = await recorded(); await queueCheckPrint(c.id, actor)
    expect(await reconcileExpiredJobs()).toBe(0)
  })
})

describe('claim-time render — a real check never prints without its MICR line', () => {
  it('builds the real E-13B line only at claim time; the stored job never contains the bank numbers', async () => {
    const c = await recorded()
    const { jobId } = await queueCheckPrint(c.id, actor)
    const stored = await pg.query<{ payload: unknown }>(`SELECT payload FROM print_jobs WHERE id = $1`, [jobId])
    expect(JSON.stringify(stored.rows[0].payload)).not.toContain(ROUTING)
    expect(JSON.stringify(stored.rows[0].payload)).not.toContain(ACCOUNT)
    const out = await renderClaimedJob((await claimNextJob('LAPTOP'))!)
    expect('pdf' in out).toBe(true)
    const pdf = (out as { pdf: Buffer }).pdf.toString('latin1')
    expect(pdf).toContain('/BaseFont /GnuMICR')
    expect(pdf).not.toContain('NOT NEGOTIABLE')                                     // no VOID watermark on a real check
    expect((pdf.match(/BT \/F3 12 Tf/g) ?? []).length).toBe(1 + ACCOUNT.length + 11 + 2 + 6) // check number = six digits
  })

  it.each([
    ['the MICR switch was turned off after sending', () => { h.cfg.micrEnabled = false }],
    ['the bank numbers disappeared', () => { delete process.env.MICR_ACCOUNT }],
  ])('REFUSES and fails the job when %s (no placeholder "check" is printed)', async (_l, breakIt) => {
    const c = await recorded()
    const { jobId } = await queueCheckPrint(c.id, actor)
    breakIt()
    const out = await renderClaimedJob((await claimNextJob('LAPTOP'))!)
    expect(out).toHaveProperty('refused')
    expect((await getJob(jobId))!.status).toBe('failed')
    expect((await getCheckRow(c.id))!.printStatus).toBe('print_failed')
  })

  it('refuses if the check is no longer recorded in QuickBooks', async () => {
    const c = await recorded()
    await queueCheckPrint(c.id, actor)
    await pg.query(`UPDATE checks SET qb_status = 'voided' WHERE id = $1`, [c.id])
    expect(await renderClaimedJob((await claimNextJob('LAPTOP'))!)).toHaveProperty('refused')
  })

  it('a VOID test page prints with its watermark and the all-zero test line — no check, no QuickBooks', async () => {
    const { jobId } = await enqueueTestPrint(actor)
    const job = (await claimNextJob('LAPTOP'))!
    expect(job.id).toBe(jobId); expect(job.checkId).toBeNull()
    const pdf = ((await renderClaimedJob(job)) as { pdf: Buffer }).pdf.toString('latin1')
    expect(pdf).toContain('(VOID - TEST - NOT NEGOTIABLE)')
    expect(JSON.stringify(job.payload)).not.toContain(ROUTING)
    await applyBridgeResult(jobId, 'submitted', null)
    expect((await getJob(jobId))!.status).toBe('submitted')
    expect(h.createCheckInQB).not.toHaveBeenCalled()
    expect(await peekNextNumber('operating')).toBe(20000)
  })
})

describe('bank specimen — the real MICR line on a VOID page, and nothing else', () => {
  const offForChecks = () => { h.cfg.micrEnabled = false; h.cfg.liveEnabled = false }

  it('prints the real line with check number 000000 while MICR and live recording are OFF', async () => {
    offForChecks()
    const { jobId, alreadyQueued } = await enqueueBankSpecimen(actor)
    expect(alreadyQueued).toBe(false)
    const stored = await pg.query<{ payload: unknown; kind: string; check_id: string | null; created_by: string }>(`SELECT payload, kind, check_id, created_by FROM print_jobs WHERE id = $1`, [jobId])
    expect(stored.rows[0]).toMatchObject({ kind: 'specimen', check_id: null, created_by: 'Torlan' })
    expect(JSON.stringify(stored.rows[0].payload)).not.toContain(ROUTING)             // bank numbers never stored
    expect(JSON.stringify(stored.rows[0].payload)).not.toContain(ACCOUNT)
    const job = (await claimNextJob('LAPTOP'))!
    const out = await renderClaimedJob(job)
    expect('pdf' in out).toBe(true)
    const pdf = (out as { pdf: Buffer }).pdf.toString('latin1')
    expect(pdf).toContain('/BaseFont /GnuMICR')
    expect((pdf.match(/BT \/F3 12 Tf/g) ?? []).length).toBe(1 + ACCOUNT.length + 11 + 2 + 6)
    expect(pdf).toContain('(VOID - BANK TEST SPECIMEN - NOT NEGOTIABLE)')
    expect(pdf).toContain('(VOID)')
    expect((await pg.query(`SELECT 1 FROM print_jobs WHERE payload::text LIKE $1`, ['%' + ACCOUNT + '%'])).rows.length).toBe(0) // still not stored after render
  })

  it('creates no check, writes nothing to QuickBooks, and leaves the check number untouched', async () => {
    offForChecks()
    await initCheckSequence('operating', 10356, 'test', true)
    const { jobId } = await enqueueBankSpecimen(actor)
    await renderClaimedJob((await claimNextJob('LAPTOP'))!)
    await applyBridgeResult(jobId, 'submitted', null)
    expect((await getJob(jobId))!.status).toBe('submitted')
    expect(await peekNextNumber('operating')).toBe(10356)
    expect((await pg.query(`SELECT 1 FROM checks`)).rows.length).toBe(0)
    expect((await pg.query(`SELECT 1 FROM check_events`)).rows.length).toBe(0)
    expect(h.createCheckInQB).not.toHaveBeenCalled()
    expect(h.resolvePayee).not.toHaveBeenCalled()
  })

  it('a second request while one is waiting returns the same job instead of printing two', async () => {
    offForChecks()
    const a = await enqueueBankSpecimen(actor)
    const b = await enqueueBankSpecimen(actor)
    expect(b).toEqual({ jobId: a.jobId, alreadyQueued: true })
    expect((await pg.query(`SELECT 1 FROM print_jobs`)).rows.length).toBe(1)
  })

  it('eight requests at the same instant queue exactly one specimen', async () => {
    offForChecks()
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => enqueueBankSpecimen(actor)))
    expect((await pg.query(`SELECT 1 FROM print_jobs WHERE kind = 'specimen'`)).rows.length).toBe(1)
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ jobId: string; alreadyQueued: boolean }>).value)
    expect(ok.filter((r) => !r.alreadyQueued).length).toBe(1)
    expect(new Set(ok.map((r) => r.jobId)).size).toBe(1)
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'specimen_cooldown' })
  })

  it('a retry AFTER it printed still does not print another (same job back) until the cooldown has passed', async () => {
    offForChecks()
    const a = await enqueueBankSpecimen(actor)
    await renderClaimedJob((await claimNextJob('LAPTOP'))!)
    await applyBridgeResult(a.jobId, 'submitted', null)
    expect(await enqueueBankSpecimen(actor)).toEqual({ jobId: a.jobId, alreadyQueued: true })
    expect((await pg.query(`SELECT 1 FROM print_jobs`)).rows.length).toBe(1)
    await pg.query(`UPDATE app_settings SET updated_at = now() - interval '11 minutes' WHERE key = 'check_specimen_slot'`)
    const later = await enqueueBankSpecimen(actor)                                    // a deliberate new one, later
    expect(later.alreadyQueued).toBe(false); expect(later.jobId).not.toBe(a.jobId)
  })

  it('a request that fails before queuing does not use up the slot', async () => {
    offForChecks()
    const real = h.cfg.layout
    h.cfg.layout = null                                                               // makes template assembly throw
    await expect(enqueueBankSpecimen(actor)).rejects.toBeDefined()
    h.cfg.layout = real
    expect((await enqueueBankSpecimen(actor)).alreadyQueued).toBe(false)
  })

  it.each([
    ['the bank numbers are missing', () => { delete process.env.MICR_ACCOUNT }],
    ['the routing number is malformed', () => { process.env.MICR_ROUTING = '021000022' }],
  ])('is refused up front when %s', async (_l, breakIt) => {
    offForChecks(); breakIt()
    await expect(enqueueBankSpecimen(actor)).rejects.toMatchObject({ code: 'micr_not_ready' })
    expect((await pg.query(`SELECT 1 FROM print_jobs`)).rows.length).toBe(0)
  })

  it('is refused at the last moment — nothing prints — if the bank numbers vanish after it was queued', async () => {
    offForChecks()
    const { jobId } = await enqueueBankSpecimen(actor)
    delete process.env.MICR_ROUTING
    const out = await renderClaimedJob((await claimNextJob('LAPTOP'))!)
    expect(out).toHaveProperty('refused')
    expect((await getJob(jobId))!.status).toBe('failed')
  })

  it('does not apply to pre-printed stock', async () => {
    h.cfg.templateMode = 'preprinted'
    await expect(enqueueBankSpecimen(actor)).rejects.toMatchObject({ code: 'specimen_not_applicable' })
  })

  it('turning the specimen on does not let a real check through: with MICR off a real check is still refused', async () => {
    offForChecks()
    await expect(createAndRecordCheck(input(), actor)).rejects.toBeInstanceOf(CheckValidationError)
    expect(await peekNextNumber('operating')).toBe(20000)
  })
})

describe('bridge status (heartbeat)', () => {
  it('reports online after a poll, offline once the bridge goes quiet, and tracks restarts', async () => {
    expect((await getBridgeStatus()).online).toBe(false)                            // never connected
    await recordBridgeHeartbeat({ bridgeId: 'LAPTOP', version: '2.0.0', platform: 'win32', printer: 'Brother HL-L2420DW Printer', startedAt: '2026-10-12T12:00:00.000Z' })
    let s = await getBridgeStatus()
    expect(s.online).toBe(true)
    expect(s.bridges[0]).toMatchObject({ bridgeId: 'LAPTOP', version: '2.0.0', startedAt: '2026-10-12T12:00:00.000Z' })
    await recordBridgeHeartbeat({ bridgeId: 'LAPTOP', version: '2.0.0', startedAt: '2026-10-12T15:30:00.000Z' }) // rebooted
    expect((await getBridgeStatus()).bridges[0].startedAt).toBe('2026-10-12T15:30:00.000Z')
    await pg.query(`UPDATE print_bridges SET last_seen_at = now() - interval '5 minutes'`)
    s = await getBridgeStatus()
    expect(s.online).toBe(false); expect(s.bridges[0].online).toBe(false)
  })
})
