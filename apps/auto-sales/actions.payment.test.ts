import { describe, it, expect, vi, beforeEach } from 'vitest'

// Auto Sales saveReceiptAction — persists the SELECTED payment source (from the verify screen) onto the
// expense event. The source may be the shared-matcher's pre-selection OR the employee's manual correction;
// either way it is validated against the approved accounts (a forged value falls back to 'unknown').
vi.mock('@/apps/auth/employee-guard', () => ({ employeeAuthorized: vi.fn(async () => true), authorizedManager: vi.fn(async () => null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('./db', () => ({
  saveReceipt: vi.fn(async () => ({ ok: true, eventId: 'ev-1' })),
  // unused-by-this-test exports referenced by the module:
  createAcquisition: vi.fn(), addExpenseEvent: vi.fn(), addReturnRefund: vi.fn(), settleRefund: vi.fn(),
  recordSale: vi.fn(), editSale: vi.fn(), reverseSale: vi.fn(), editAcquisitionPrice: vi.fn(), updateCloseout: vi.fn(), resolveVin: vi.fn(),
}))

import { saveReceiptAction } from './actions'
import * as db from './db'
const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const base = { documentId: 'doc-1', vehicleId: 'veh-1', categoryLabel: 'Parts', amountDollars: '57.63', eventDate: '2026-03-14' }
beforeEach(() => vi.clearAllMocks())

describe('auto-sales saveReceiptAction — persists the selected/corrected payment source', () => {
  it('saves the matched/selected approved account onto the event', async () => {
    await saveReceiptAction({ ...base, paymentAccountRef: '*2649' })
    expect(asMock(db.saveReceipt).mock.calls[0][0].paymentAccountRef).toBe('*2649')
  })
  it('a MANUAL correction to a different approved account is what gets saved', async () => {
    await saveReceiptAction({ ...base, paymentAccountRef: '*5600' })
    expect(asMock(db.saveReceipt).mock.calls[0][0].paymentAccountRef).toBe('*5600')
  })
  it('a forged / non-approved account falls back to "unknown" (never trusted from the client)', async () => {
    await saveReceiptAction({ ...base, paymentAccountRef: '*9999-evil' })
    expect(asMock(db.saveReceipt).mock.calls[0][0].paymentAccountRef).toBe('unknown')
  })
  it('an unresolved source (no selection) saves as "unknown", not Personal or a guessed bank', async () => {
    await saveReceiptAction({ ...base })
    expect(asMock(db.saveReceipt).mock.calls[0][0].paymentAccountRef).toBe('unknown')
  })
})
