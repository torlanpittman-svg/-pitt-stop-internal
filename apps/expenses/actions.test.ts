import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the auth guard + db + cache so we can exercise the ACTION-LAYER authorization without a request
// scope or a database. This proves approval/rejection fail closed and attribute the real manager identity.
vi.mock('@/apps/auth/employee-guard', () => ({ authorizedManager: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('./db', () => ({
  saveReview: vi.fn(async () => ({ ok: true })),
  approveReceipt: vi.fn(async () => ({ ok: true })),
  rejectReceipt: vi.fn(async () => ({ ok: true })),
  reopenReceipt: vi.fn(async () => ({ ok: true })),
  getReceipt: vi.fn(),
  applyRetryExtraction: vi.fn(async () => ({ ok: true })),
  inventoryVehicleExists: vi.fn(async () => true),
}))

import { authorizedManager } from '@/apps/auth/employee-guard'
import { approveReceiptAction, rejectReceiptAction, saveReviewAction, retryExtractionAction } from './actions'
import * as db from './db'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const manager = { key: 'darryl', name: 'Darryl', role: 'manager' }

beforeEach(() => { vi.clearAllMocks(); asMock(db.inventoryVehicleExists).mockResolvedValue(true) })

describe('action-layer authorization (fails closed)', () => {
  it('anonymous / employee cannot approve — no db write happens', async () => {
    asMock(authorizedManager).mockResolvedValue(null) // not a manager
    const r = await approveReceiptAction({ id: 'r1', entity: 'detail', total: '19.99' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Manager sign-in required/i)
    expect(asMock(db.approveReceipt)).not.toHaveBeenCalled()
  })

  it('employee cannot reject', async () => {
    asMock(authorizedManager).mockResolvedValue(null)
    const r = await rejectReceiptAction({ id: 'r1', reason: 'blurry' })
    expect(r.ok).toBe(false)
    expect(asMock(db.rejectReceipt)).not.toHaveBeenCalled()
  })

  it('manager approval passes the real manager identity for attribution', async () => {
    asMock(authorizedManager).mockResolvedValue({ key: 'darryl', name: 'Darryl', role: 'manager' })
    const r = await approveReceiptAction({ id: 'r1', entity: 'auto_sales', total: '48.71', vendor: "O'Reilly" })
    expect(r.ok).toBe(true)
    expect(asMock(db.approveReceipt)).toHaveBeenCalledTimes(1)
    const [id, fields, actor] = asMock(db.approveReceipt).mock.calls[0]
    expect(id).toBe('r1')
    expect(actor).toBe('Darryl')          // audit attribution = verified manager name, not client input
    expect(fields.entity).toBe('auto_sales')
    expect(fields.totalCents).toBe(4871)  // parsed to integer cents at the action boundary
  })

  it('manager save parses cents and passes validated fields', async () => {
    asMock(authorizedManager).mockResolvedValue({ key: 'tony', name: 'Tony', role: 'manager' })
    const r = await saveReviewAction({ id: 'r2', total: '1,250.00', tax: '', category: 'parts', entity: 'detail' })
    expect(r.ok).toBe(true)
    const [, fields] = asMock(db.saveReview).mock.calls[0]
    expect(fields.totalCents).toBe(125000)
    expect(fields.taxCents).toBeNull()    // cleared field → null, never $0
    expect(fields.category).toBe('parts')
  })

  it('rejects an invalid entity/category down to safe defaults', async () => {
    asMock(authorizedManager).mockResolvedValue({ key: 'tony', name: 'Tony', role: 'manager' })
    await saveReviewAction({ id: 'r3', entity: 'hackery', category: 'nonsense' })
    const [, fields] = asMock(db.saveReview).mock.calls[0]
    expect(fields.entity).toBe('unassigned')
    expect(fields.category).toBe('uncategorized')
  })
})

describe('vehicle association validation', () => {
  it('rejects a nonexistent inventory vehicle on approve (no db write)', async () => {
    asMock(authorizedManager).mockResolvedValue(manager)
    asMock(db.inventoryVehicleExists).mockResolvedValue(false)
    const r = await approveReceiptAction({ id: 'r1', entity: 'auto_sales', total: '100.00', inventoryVehicleId: 'bogus-id' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/vehicle/i)
    expect(asMock(db.approveReceipt)).not.toHaveBeenCalled()
  })

  it('accepts a valid inventory vehicle association', async () => {
    asMock(authorizedManager).mockResolvedValue(manager)
    asMock(db.inventoryVehicleExists).mockResolvedValue(true)
    const r = await approveReceiptAction({ id: 'r1', entity: 'auto_sales', total: '100.00', inventoryVehicleId: 'veh-123' })
    expect(r.ok).toBe(true)
    const [, fields] = asMock(db.approveReceipt).mock.calls[0]
    expect(fields.inventoryVehicleId).toBe('veh-123')
  })

  it('a general expense with no vehicle never triggers the existence check', async () => {
    asMock(authorizedManager).mockResolvedValue(manager)
    const r = await saveReviewAction({ id: 'r1', entity: 'detail', total: '10.00' })
    expect(r.ok).toBe(true)
    expect(asMock(db.inventoryVehicleExists)).not.toHaveBeenCalled()
  })

  it('clearing the association (empty string) is allowed without an existence check', async () => {
    asMock(authorizedManager).mockResolvedValue(manager)
    await saveReviewAction({ id: 'r1', inventoryVehicleId: '' })
    expect(asMock(db.inventoryVehicleExists)).not.toHaveBeenCalled()
    const [, fields] = asMock(db.saveReview).mock.calls[0]
    expect(fields.inventoryVehicleId).toBeNull()
  })
})

describe('retry extraction is manager-only', () => {
  it('an anonymous/employee caller cannot retry — no receipt is loaded', async () => {
    asMock(authorizedManager).mockResolvedValue(null)
    const r = await retryExtractionAction({ id: 'r1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Manager sign-in required/i)
    expect(asMock(db.getReceipt)).not.toHaveBeenCalled()
  })
})
