import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the receipt authz + db + cache so we exercise ACTION-LAYER behavior without a request scope or a
// database. This proves approve/reject/retry fail closed, attribute the real manager, and drive the retry
// lock. authz is mocked (its own fail-closed logic is covered in authz.test.ts).
vi.mock('./authz', () => ({ receiptManager: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/platform/blob', () => ({ getPrivateBlob: vi.fn(async () => ({ bytes: Buffer.from([1]), contentType: 'image/jpeg', size: 1 })) }))
vi.mock('./ai', () => ({ extractExpense: vi.fn(async () => ({ status: 'extracted', model: 'gpt-4o', raw: {}, extraction: { vendor: 'V', date: null, subtotalCents: null, taxCents: null, totalCents: 100, categoryLabel: null, categoryKey: 'other', paymentMethod: null, paymentLast4: null, receiptNumber: null, present: {} } })) }))
vi.mock('./db', () => ({
  saveReview: vi.fn(async () => ({ ok: true })),
  approveReceipt: vi.fn(async () => ({ ok: true })),
  rejectReceipt: vi.fn(async () => ({ ok: true })),
  reopenReceipt: vi.fn(async () => ({ ok: true })),
  claimRetryExtraction: vi.fn(async () => ({ ok: true, row: { id: 'r1', storage: 'blob_private', storageRef: 'business-receipts/x.jpg', contentType: 'image/jpeg' }, token: 'tok-1' })),
  applyRetryExtraction: vi.fn(async () => ({ ok: true })),
  releaseRetryClaim: vi.fn(async () => {}),
  inventoryVehicleExists: vi.fn(async () => true),
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
  RATE_LIMITS: { upload: { limit: 60, windowMs: 600000 }, extractActor: { limit: 30, windowMs: 600000 }, extractReceipt: { limit: 10, windowMs: 3600000 } },
}))

import { receiptManager } from './authz'
import { approveReceiptAction, rejectReceiptAction, saveReviewAction, retryExtractionAction } from './actions'
import * as db from './db'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const manager = { key: 'darryl', name: 'Darryl', role: 'manager' }

beforeEach(() => {
  vi.clearAllMocks()
  asMock(db.inventoryVehicleExists).mockResolvedValue(true)
  asMock(db.consumeRateLimit).mockResolvedValue({ ok: true })
  asMock(db.claimRetryExtraction).mockResolvedValue({ ok: true, row: { id: 'r1', storage: 'blob_private', storageRef: 'business-receipts/x.jpg', contentType: 'image/jpeg' }, token: 'tok-1' })
})

describe('action-layer authorization (fails closed)', () => {
  it('anonymous / employee cannot approve — no db write happens', async () => {
    asMock(receiptManager).mockResolvedValue(null)
    const r = await approveReceiptAction({ id: 'r1', entity: 'detail', total: '19.99' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Manager sign-in required/i)
    expect(asMock(db.approveReceipt)).not.toHaveBeenCalled()
  })

  it('employee cannot reject', async () => {
    asMock(receiptManager).mockResolvedValue(null)
    const r = await rejectReceiptAction({ id: 'r1', reason: 'blurry' })
    expect(r.ok).toBe(false)
    expect(asMock(db.rejectReceipt)).not.toHaveBeenCalled()
  })

  it('manager approval passes the real manager identity for attribution', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    const r = await approveReceiptAction({ id: 'r1', entity: 'auto_sales', total: '48.71', vendor: "O'Reilly" })
    expect(r.ok).toBe(true)
    const [id, fields, actor] = asMock(db.approveReceipt).mock.calls[0]
    expect(id).toBe('r1')
    expect(actor).toBe('Darryl')          // audit attribution = verified manager name, not client input
    expect(fields.entity).toBe('auto_sales')
    expect(fields.totalCents).toBe(4871)  // parsed to integer cents at the action boundary
  })

  it('manager save parses cents and passes validated fields', async () => {
    asMock(receiptManager).mockResolvedValue({ key: 'tony', name: 'Tony', role: 'manager' })
    const r = await saveReviewAction({ id: 'r2', total: '1,250.00', tax: '', category: 'parts', entity: 'detail' })
    expect(r.ok).toBe(true)
    const [, fields] = asMock(db.saveReview).mock.calls[0]
    expect(fields.totalCents).toBe(125000)
    expect(fields.taxCents).toBeNull()    // cleared field → null, never $0
    expect(fields.category).toBe('parts')
  })

  it('rejects an invalid entity/category down to safe defaults', async () => {
    asMock(receiptManager).mockResolvedValue({ key: 'tony', name: 'Tony', role: 'manager' })
    await saveReviewAction({ id: 'r3', entity: 'hackery', category: 'nonsense' })
    const [, fields] = asMock(db.saveReview).mock.calls[0]
    expect(fields.entity).toBe('unassigned')
    expect(fields.category).toBe('uncategorized')
  })
})

describe('vehicle association validation', () => {
  it('rejects a nonexistent inventory vehicle on approve (no db write)', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    asMock(db.inventoryVehicleExists).mockResolvedValue(false)
    const r = await approveReceiptAction({ id: 'r1', entity: 'auto_sales', total: '100.00', inventoryVehicleId: 'bogus-id' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/vehicle/i)
    expect(asMock(db.approveReceipt)).not.toHaveBeenCalled()
  })

  it('accepts a valid inventory vehicle association', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    asMock(db.inventoryVehicleExists).mockResolvedValue(true)
    const r = await approveReceiptAction({ id: 'r1', entity: 'auto_sales', total: '100.00', receiptDate: '2026-09-14', inventoryVehicleId: 'veh-123' })
    expect(r.ok).toBe(true)
    const [, fields] = asMock(db.approveReceipt).mock.calls[0]
    expect(fields.inventoryVehicleId).toBe('veh-123')
  })

  it('a general expense with no vehicle never triggers the existence check', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    const r = await saveReviewAction({ id: 'r1', entity: 'detail', total: '10.00' })
    expect(r.ok).toBe(true)
    expect(asMock(db.inventoryVehicleExists)).not.toHaveBeenCalled()
  })

  it('clearing the association (empty string) is allowed without an existence check', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    await saveReviewAction({ id: 'r1', inventoryVehicleId: '' })
    expect(asMock(db.inventoryVehicleExists)).not.toHaveBeenCalled()
    const [, fields] = asMock(db.saveReview).mock.calls[0]
    expect(fields.inventoryVehicleId).toBeNull()
  })
})

describe('retry extraction — manager-only + concurrency lock', () => {
  it('an anonymous/employee caller cannot retry — the lock is never claimed', async () => {
    asMock(receiptManager).mockResolvedValue(null)
    const r = await retryExtractionAction({ id: 'r1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Manager sign-in required/i)
    expect(asMock(db.claimRetryExtraction)).not.toHaveBeenCalled()
  })

  it('a busy receipt (lock already held) is not re-extracted', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    asMock(db.claimRetryExtraction).mockResolvedValue({ ok: false, busy: true, error: 'already being re-read' })
    const r = await retryExtractionAction({ id: 'r1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/re-read/i)
    expect(asMock(db.applyRetryExtraction)).not.toHaveBeenCalled()
  })

  it('a rate-limited manager is refused BEFORE claiming the lock or calling AI', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    asMock(db.consumeRateLimit).mockResolvedValue({ ok: false, retryAfterSec: 30 })
    const r = await retryExtractionAction({ id: 'r1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/try again/i)
    expect(asMock(db.claimRetryExtraction)).not.toHaveBeenCalled()
  })

  it('a successful retry claims the lock (with its token), extracts, and applies once', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    const r = await retryExtractionAction({ id: 'r1' })
    expect(r.ok).toBe(true)
    expect(asMock(db.claimRetryExtraction)).toHaveBeenCalledTimes(1)
    expect(asMock(db.applyRetryExtraction)).toHaveBeenCalledTimes(1)
    // the owned attempt token flows from claim → apply
    expect(asMock(db.applyRetryExtraction).mock.calls[0][1]).toBe('tok-1')
    expect(asMock(db.releaseRetryClaim)).not.toHaveBeenCalled()
  })

  it('releases the lock (no stuck processing) when the stored image cannot be loaded', async () => {
    asMock(receiptManager).mockResolvedValue(manager)
    const { getPrivateBlob } = await import('@/platform/blob')
    asMock(getPrivateBlob).mockResolvedValueOnce(null)
    const r = await retryExtractionAction({ id: 'r1' })
    expect(r.ok).toBe(false)
    expect(asMock(db.releaseRetryClaim)).toHaveBeenCalledTimes(1)
    expect(asMock(db.applyRetryExtraction)).not.toHaveBeenCalled()
  })
})
