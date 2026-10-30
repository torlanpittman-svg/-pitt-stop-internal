import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('./authz', () => ({ receiptUploader: vi.fn(), receiptManager: vi.fn(async () => null), canFileReceipt: vi.fn(() => true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('./db', () => ({
  getReceipt: vi.fn(async () => ({ id: 'r1', uploadedByKey: 'sam', funding: 'business', paymentMethod: 'card', accountRef: '*2649' })),
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
  fileReceipt: vi.fn(async () => ({ ok: true, status: 'filed' })),
  RATE_LIMITS: { file: { limit: 120, windowMs: 600000 } },
}))
import { receiptUploader, canFileReceipt } from './authz'
import { fileReceipt } from './db'
import { fileReceiptAction } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(receiptUploader).mockResolvedValue({ name: 'Sam', actor: { key: 'sam', name: 'Sam', role: 'employee' } })
  vi.mocked(canFileReceipt).mockReturnValue(true)
})

it('uses server-defined account/funding even if the client posts contradictory fields', async () => {
  await fileReceiptAction({ id: 'r1', paymentChoice: 'extraco_check', funding: 'personal', paymentMethod: 'cash' })
  expect(vi.mocked(fileReceipt).mock.calls[0][1]).toMatchObject({ accountRef: '*5600', paymentMethod: 'check', funding: 'business' })
})
it('validates Other text before filing', async () => {
  expect((await fileReceiptAction({ id: 'r1', paymentChoice: 'other', otherPayment: ' ' })).ok).toBe(false)
  expect(fileReceipt).not.toHaveBeenCalled()
})
it('an Other source is classified from the explicit answers, server-side', async () => {
  await fileReceiptAction({ id: 'r1', paymentChoice: 'other', otherPayment: 'AMEX 5008', otherFunding: 'business', otherPaymentMethod: 'card' })
  expect(vi.mocked(fileReceipt).mock.calls[0][1]).toMatchObject({ funding: 'business', paymentMethod: 'card', accountRef: 'other:AMEX 5008', paymentLast4: null })
})
it('an Other source with no classification stays unknown funding (never inferred from the text)', async () => {
  await fileReceiptAction({ id: 'r1', paymentChoice: 'other', otherPayment: 'business amex', funding: 'business', paymentMethod: 'card' })
  expect(vi.mocked(fileReceipt).mock.calls[0][1]).toMatchObject({ funding: 'unknown', paymentMethod: null, accountRef: 'other:business amex' })
})
it('a personal Other keeps the description and the personal funding', async () => {
  await fileReceiptAction({ id: 'r1', paymentChoice: 'other', otherPayment: 'AMEX 5008', otherFunding: 'personal', otherPaymentMethod: 'card' })
  expect(vi.mocked(fileReceipt).mock.calls[0][1]).toMatchObject({ funding: 'personal', paymentMethod: null, accountRef: 'other:AMEX 5008' })
})
it('a forged Other classification cannot assert business funding', async () => {
  await fileReceiptAction({ id: 'r1', paymentChoice: 'other', otherPayment: 'AMEX 5008', otherFunding: 'definitely-business' })
  expect(vi.mocked(fileReceipt).mock.calls[0][1]).toMatchObject({ funding: 'unknown', paymentMethod: null })
})
it('cannot change another uploader’s receipt', async () => {
  vi.mocked(canFileReceipt).mockReturnValue(false)
  expect((await fileReceiptAction({ id: 'r1', paymentChoice: 'amb_debit' })).ok).toBe(false)
  expect(fileReceipt).not.toHaveBeenCalled()
})
it('clears the old bank when changing to personal', async () => {
  await fileReceiptAction({ id: 'r1', paymentChoice: 'personal' })
  expect(vi.mocked(fileReceipt).mock.calls[0][1]).toMatchObject({ accountRef: null, paymentMethod: null, funding: 'personal' })
})
it('preserves historical account references when legacy review does not change payment', async () => {
  await fileReceiptAction({ id: 'r1', funding: 'business', paymentMethod: 'card' })
  expect(vi.mocked(fileReceipt).mock.calls[0][1].accountRef).toBeUndefined()
})
