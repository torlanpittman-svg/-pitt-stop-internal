import { describe, it, expect, vi, beforeEach } from 'vitest'

// Auto Sales receipt scan — end to end with mocked extraction + storage. Verifies the SHARED payment-source
// matcher is wired: card evidence on the receipt resolves to an approved bank account_ref returned in the
// response (which the verify screen pre-selects); unresolved evidence stays null. The matcher itself stays
// REAL (deterministic). Auth is dev-open here (no EMPLOYEE_PIN configured), matching middleware.
vi.mock('@/apps/auth/employee-session', () => ({ EMP_COOKIE: 'ps_emp', employeePinConfigured: () => false, verifyEmployeeToken: vi.fn(async () => null) }))
vi.mock('@/platform/blob', () => ({ uploadPhoto: vi.fn(async () => 'https://blob/auto-sales-receipts/x.jpg') }))
vi.mock('@/apps/auto-sales/ai/receipt', () => ({ extractReceipt: vi.fn() }))
vi.mock('@/apps/auto-sales/db', () => ({
  findDocumentByHash: vi.fn(async () => null),
  createReceiptDocument: vi.fn(async () => 'doc-1'),
  proposeReturnMatch: vi.fn(async () => null),
}))

import { POST } from './route'
import { extractReceipt } from '@/apps/auto-sales/ai/receipt'

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>
const EXTRACTION = { vendor: 'O’Reilly', date: '2026-03-14', totalCents: 5763, subtotalCents: null, taxCents: null, categoryLabel: 'Parts', lineItems: [], paymentMethod: null as string | null, cardBrand: null as string | null, paymentLast4: null as string | null, receiptNumber: null, documentType: 'purchase', originalReference: null, isReturn: false }
const scanReq = () => {
  const fd = new FormData()
  fd.set('receipt', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'r.jpg', { type: 'image/jpeg' }))
  fd.set('inventoryVehicleId', 'veh-1')
  return new Request('http://x/api/auto-sales/receipt/scan', { method: 'POST', body: fd })
}
beforeEach(() => vi.clearAllMocks())

describe('auto-sales scan — shared payment-source match', () => {
  it('resolves an approved card ending to its bank account_ref in the response', async () => {
    asMock(extractReceipt).mockResolvedValue({ status: 'extracted', model: 'gpt-4o', raw: {}, extraction: { ...EXTRACTION, paymentMethod: 'card', cardBrand: 'discover', paymentLast4: '1068' } })
    const j = await (await POST(scanReq())).json()
    expect(j.ok).toBe(true)
    expect(j.matchedAccountRef).toBe('*5600') // Extraco debit ••1068 → Extraco checking *5600
  })

  it('the two AMB cards both resolve to *2649 (event-level bank granularity)', async () => {
    asMock(extractReceipt).mockResolvedValue({ status: 'extracted', model: 'gpt-4o', raw: {}, extraction: { ...EXTRACTION, paymentMethod: 'card', cardBrand: 'mastercard', paymentLast4: '0320' } })
    expect((await (await POST(scanReq())).json()).matchedAccountRef).toBe('*2649')
  })

  it('unresolved evidence (check alone / unknown card) returns null → verify screen stays "unknown"', async () => {
    asMock(extractReceipt).mockResolvedValue({ status: 'extracted', model: 'gpt-4o', raw: {}, extraction: { ...EXTRACTION, paymentMethod: 'check' } })
    expect((await (await POST(scanReq())).json()).matchedAccountRef).toBeNull()
    asMock(extractReceipt).mockResolvedValue({ status: 'extracted', model: 'gpt-4o', raw: {}, extraction: { ...EXTRACTION, paymentMethod: 'card', paymentLast4: '9999' } })
    expect((await (await POST(scanReq())).json()).matchedAccountRef).toBeNull()
  })
})
