import { vi, describe, it, expect, beforeEach } from 'vitest'

/**
 * Exercises the check state machine deterministically — no DB, no QuickBooks, no network. An in-memory
 * row store (vi.hoisted) backs the mocked db so state transitions (recorded / failed / printed / reprint)
 * are observable. Covers: QB idempotency, QB-failure-prevents-print, reprint-never-rewrites-QBO,
 * print idempotency, queue requires recorded, and bridge-result application.
 */
const h = vi.hoisted(() => ({
  rows: new Map<string, any>(), idem: new Map<string, string>(), n: 0, jobs: new Map<string, any>(),
  reserveNextNumber: vi.fn(), releaseIfLast: vi.fn(), resolveVendor: vi.fn(),
  createCheckInQB: vi.fn(), findCheckByDocNumber: vi.fn(),
  enqueuePrintJob: vi.fn(), getJob: vi.fn(), markJobPrinted: vi.fn(), markJobFailed: vi.fn(),
}))

function view(r: any) {
  return {
    id: r.id, checkNumber: r.checkNumber, bankKey: r.bankKey, bankLabel: 'Op', payeeName: r.payeeName,
    amountCents: r.amountCents, memo: r.memo, category: r.category, categoryLabel: r.category, entity: r.entity,
    linkedJobId: null, linkedVehicleId: null, checkDate: r.checkDate, qboTxnId: r.qboTxnId, qboDocNumber: r.qboDocNumber,
    qbStatus: r.qbStatus, qbError: r.qbError ?? null, printStatus: r.printStatus, printedAt: null, reprintCount: r.reprintCount, actorName: null, createdAt: new Date().toISOString(),
  }
}

vi.mock('./db', () => ({
  insertCheck: vi.fn(async (input: any) => {
    const id = 'chk-' + (++h.n)
    h.rows.set(id, { id, ...input, entity: input.entity, qbStatus: 'pending', qboTxnId: null, qboDocNumber: null, qboSyncToken: null, qbError: null, realmId: null, printStatus: 'not_printed', reprintCount: 0 })
    h.idem.set(input.idempotencyKey, id)
    return id
  }),
  getCheckByIdempotencyKey: vi.fn(async (k: string) => { const id = h.idem.get(k); return id ? h.rows.get(id) : null }),
  getCheckRow: vi.fn(async (id: string) => h.rows.get(id) ?? null),
  markRecorded: vi.fn(async (id: string, qbo: any) => { Object.assign(h.rows.get(id), { qboTxnId: qbo.txnId, qboDocNumber: qbo.docNumber, qboSyncToken: qbo.syncToken, realmId: qbo.realmId, qbStatus: 'recorded', qbError: null }) }),
  markQbFailed: vi.fn(async (id: string, err: string) => { Object.assign(h.rows.get(id), { qbStatus: 'failed', qbError: err }) }),
  setPrintStatus: vi.fn(async (id: string, status: string, opts: any = {}) => { const r = h.rows.get(id); r.printStatus = status; if (opts.bumpReprint) r.reprintCount++; return r }),
  logCheckEvent: vi.fn(async () => {}),
  toView: vi.fn((r: any) => view(r)),
  getCheckView: vi.fn(async (id: string) => { const r = h.rows.get(id); return r ? view(r) : null }),
}))

vi.mock('./config', () => ({
  getCheckConfig: vi.fn(async () => ({
    enabled: true,
    liveEnabled: true, // record-path tests exercise recording as if the owner has gone live
    banks: { operating: { key: 'operating', qboAccountId: '31', label: 'Op' }, auto_sales: { key: 'auto_sales', qboAccountId: '99', label: 'AS' } },
    categoryAccounts: { shop_general: '7', customer_job: '7', equipment: '7', owner_personal: '7', other: '7', auto_sales: '8' },
    layout: {},
  })),
  bankForCategory: (cfg: any, cat: string) => cfg.banks[cat === 'auto_sales' ? 'auto_sales' : 'operating'],
  checkConfigReadiness: () => ({ ready: true, enabled: true, operatingBankConfigured: true, autoSalesBankConfigured: true, missingCategoryAccounts: [] }),
}))

vi.mock('./vendor', () => ({ resolveVendor: h.resolveVendor }))
vi.mock('./numbering', () => ({ reserveNextNumber: h.reserveNextNumber, releaseIfLast: h.releaseIfLast }))
vi.mock('./qb-check', () => ({ createCheckInQB: h.createCheckInQB, findCheckByDocNumber: h.findCheckByDocNumber }))
vi.mock('./print-queue', () => ({ enqueuePrintJob: h.enqueuePrintJob, getJob: h.getJob, markJobPrinted: h.markJobPrinted, markJobFailed: h.markJobFailed }))
vi.mock('./render', () => ({ buildCheckPayload: vi.fn(() => ({ pageWidthIn: 8.5, pageHeightIn: 11, fields: [] })) }))
vi.mock('@/apps/quickbooks/connection', () => ({ getValidAccessToken: vi.fn(async () => ({ realmId: 'R1', accessToken: 'x', environment: 'production' })) }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { createAndRecordCheck, retryQbWrite, recordPrintResult, queueCheckPrint, applyBridgeResult, CheckValidationError } from './service'
import { getCheckConfig } from './config'

// Aliases to the hoisted mocks for readable assertions.
const createCheckInQB = h.createCheckInQB
const findCheckByDocNumber = h.findCheckByDocNumber
const reserveNextNumber = h.reserveNextNumber
const enqueuePrintJob = h.enqueuePrintJob

const ACTOR = { key: 'torlan', name: 'Torlan' }
const baseInput = (over: any = {}) => ({ payeeName: 'Acme', amountCents: 100000, category: 'shop_general', idempotencyKey: 'k-' + Math.random(), ...over })

beforeEach(() => {
  h.rows.clear(); h.idem.clear(); h.jobs.clear(); h.n = 0
  h.reserveNextNumber.mockReset(); h.releaseIfLast.mockReset(); h.createCheckInQB.mockReset(); h.findCheckByDocNumber.mockReset()
  h.enqueuePrintJob.mockReset(); h.getJob.mockReset(); h.markJobPrinted.mockReset(); h.markJobFailed.mockReset()
  h.resolveVendor.mockReset()
  h.resolveVendor.mockResolvedValue({ id: 'v1', displayName: 'Acme', active: true })
  h.reserveNextNumber.mockImplementation(async () => 1000 + (++h.n))
  h.releaseIfLast.mockResolvedValue(true)
  h.findCheckByDocNumber.mockResolvedValue(null)
  h.createCheckInQB.mockImplementation(async (p: any) => ({ purchaseId: 'P-' + p.docNumber, docNumber: p.docNumber, syncToken: '0', totalCents: p.amountCents }))
  h.enqueuePrintJob.mockImplementation(async (p: any) => { const id = 'job-' + (++h.n); const job = { id, checkId: p.checkId, kind: p.kind, status: 'queued' }; h.jobs.set(id, job); return job })
  h.getJob.mockImplementation(async (id: string) => h.jobs.get(id) ?? null)
  h.markJobPrinted.mockResolvedValue(undefined)
  h.markJobFailed.mockResolvedValue(undefined)
})

describe('createAndRecordCheck — record path', () => {
  it('records the check in QuickBooks exactly once and returns recorded', async () => {
    const { recorded, check } = await createAndRecordCheck(baseInput(), ACTOR)
    expect(recorded).toBe(true)
    expect(check.qbStatus).toBe('recorded')
    expect(createCheckInQB).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-positive amount before reserving a number', async () => {
    await expect(createAndRecordCheck(baseInput({ amountCents: 0 }), ACTOR)).rejects.toBeInstanceOf(CheckValidationError)
    expect(reserveNextNumber).not.toHaveBeenCalled()
    expect(createCheckInQB).not.toHaveBeenCalled()
  })

  it('is idempotent: a replay with the same idempotencyKey never writes QuickBooks twice', async () => {
    const input = baseInput()
    const first = await createAndRecordCheck(input, ACTOR)
    const second = await createAndRecordCheck(input, ACTOR)
    expect(second.check.id).toBe(first.check.id)
    expect(createCheckInQB).toHaveBeenCalledTimes(1)
    expect(reserveNextNumber).toHaveBeenCalledTimes(1)
  })

  it('routes Auto Sales checks to the auto_sales bank (operating isolation)', async () => {
    await createAndRecordCheck(baseInput({ category: 'auto_sales' }), ACTOR)
    expect(createCheckInQB).toHaveBeenCalledWith(expect.objectContaining({ bankAccountId: '99', expenseAccountId: '8' }))
  })
})

describe('QB failure never prints a negotiable check', () => {
  it('marks failed and does not record when QuickBooks throws', async () => {
    createCheckInQB.mockRejectedValueOnce(new Error('QB 400'))
    const { recorded, check } = await createAndRecordCheck(baseInput(), ACTOR)
    expect(recorded).toBe(false)
    expect(check.qbStatus).toBe('failed')
  })

  it('recordPrintResult refuses to mark a non-recorded check printed', async () => {
    createCheckInQB.mockRejectedValueOnce(new Error('QB 400'))
    const { check } = await createAndRecordCheck(baseInput(), ACTOR)
    await expect(recordPrintResult(check.id, true, ACTOR)).rejects.toMatchObject({ code: 'not_recorded' })
  })

  it('queueCheckPrint refuses to queue a non-recorded check', async () => {
    createCheckInQB.mockRejectedValueOnce(new Error('QB 400'))
    const { check } = await createAndRecordCheck(baseInput(), ACTOR)
    await expect(queueCheckPrint(check.id, ACTOR)).rejects.toMatchObject({ code: 'not_recorded' })
    expect(enqueuePrintJob).not.toHaveBeenCalled()
  })
})

describe('retry is safe (adoption / no duplicate Purchase)', () => {
  it('retry on an already-recorded check does NOT write QuickBooks again', async () => {
    const { check } = await createAndRecordCheck(baseInput(), ACTOR)
    createCheckInQB.mockClear()
    const r = await retryQbWrite(check.id, ACTOR)
    expect(r.recorded).toBe(true)
    expect(createCheckInQB).not.toHaveBeenCalled()
  })

  it('retry after a failure records with the SAME check number', async () => {
    createCheckInQB.mockRejectedValueOnce(new Error('QB 500'))
    const { check } = await createAndRecordCheck(baseInput(), ACTOR)
    const r = await retryQbWrite(check.id, ACTOR)
    expect(r.recorded).toBe(true)
    const row = h.rows.get(check.id)
    expect(row.qbStatus).toBe('recorded')
    expect(String(row.qboDocNumber)).toBe(String(row.checkNumber))
  })
})

describe('print + reprint idempotency (never re-writes QuickBooks)', () => {
  it('marks printed and never calls QuickBooks', async () => {
    const { check } = await createAndRecordCheck(baseInput(), ACTOR)
    createCheckInQB.mockClear()
    const v = await recordPrintResult(check.id, true, ACTOR)
    expect(v.printStatus).toBe('printed')
    expect(createCheckInQB).not.toHaveBeenCalled()
  })

  it('reprint bumps reprintCount and never writes a new Purchase', async () => {
    const { check } = await createAndRecordCheck(baseInput(), ACTOR)
    await recordPrintResult(check.id, true, ACTOR)
    createCheckInQB.mockClear()
    const v = await recordPrintResult(check.id, true, ACTOR, { reprint: true })
    expect(v.reprintCount).toBe(1)
    expect(createCheckInQB).not.toHaveBeenCalled()
  })

  it('queueCheckPrint enqueues a recorded check without touching QuickBooks', async () => {
    const { check } = await createAndRecordCheck(baseInput(), ACTOR)
    createCheckInQB.mockClear()
    const { jobId } = await queueCheckPrint(check.id, ACTOR)
    expect(jobId).toBeTruthy()
    expect(enqueuePrintJob).toHaveBeenCalledTimes(1)
    expect(createCheckInQB).not.toHaveBeenCalled()
  })
})

describe('live gate — no real side effects until the owner goes live', () => {
  it('refuses to record (no QB Purchase, no number consumed) when liveEnabled is false', async () => {
    const base = await (getCheckConfig as any)()
    ;(getCheckConfig as any).mockResolvedValueOnce({ ...base, liveEnabled: false })
    createCheckInQB.mockClear(); reserveNextNumber.mockClear()
    await expect(createAndRecordCheck(baseInput(), ACTOR)).rejects.toMatchObject({ code: 'live_not_enabled' })
    expect(createCheckInQB).not.toHaveBeenCalled()   // no QuickBooks Purchase
    expect(reserveNextNumber).not.toHaveBeenCalled() // no check number consumed
  })
})

describe('applyBridgeResult reflects onto the check', () => {
  it('a successful bridge result marks the check printed', async () => {
    const { check } = await createAndRecordCheck(baseInput(), ACTOR)
    const { jobId } = await queueCheckPrint(check.id, ACTOR)
    await applyBridgeResult(jobId, true, null)
    expect(h.rows.get(check.id).printStatus).toBe('printed')
  })
})
