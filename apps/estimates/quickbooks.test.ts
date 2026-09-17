import { beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  intake: {} as Record<string, unknown>, full: {} as Record<string, unknown>,
  contact: { customerName: 'Test Customer', customerEmail: 'customer@realshop.net', customerPhone: '5125550123' },
  api: vi.fn(), order: { id: 'order', status: 'estimate', notes: null },
  payload: { lines: [{ itemId: 'labor', description: 'Interior detail', amountCents: 10000 }], privateNote: 'PSID:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', customerMemo: '2020 Honda Civic', totalCents: 10000 },
}))
vi.mock('@/platform/db', () => ({ getDb: () => ({
  select: () => ({ from: (table: { orderId?: unknown }) => ({ where: async () => [table.orderId ? { ...f.intake } : f.contact] }) }),
  update: () => ({ set: (patch: object) => ({ where: async () => { Object.assign(f.intake, patch) } }) }),
}) }))
vi.mock('@/apps/workflow/db', () => ({ getOrderWithContext: async () => f.order, logEvent: vi.fn() }))
vi.mock('@/apps/workflow/estimate-db', () => ({ getFullEstimate: async () => f.full, itemizeEstimate: vi.fn(), recomputeEstimate: vi.fn() }))
vi.mock('@/apps/workflow/invoice-draft', () => ({ buildInvoiceDraft: () => ({ priced: true, tax: { cents: 0, needsReview: false }, totalCents: 10000 }) }))
vi.mock('@/apps/settings/db', () => ({ getBusinessConfig: async () => ({ paymentLabel: 'Card charge' }) }))
vi.mock('@/apps/quickbooks/retail-invoice-service', () => ({ buildRetailWorkPayload: async () => ({ payload: f.payload }) }))
vi.mock('@/apps/quickbooks/retail-customer', () => ({ resolveRetailCustomer: async () => ({ qbCustomerId: 'customer-id' }), isPlaceholderEmail: (s: string) => !s || s === 'no@no.com' }))
vi.mock('@/apps/quickbooks/client', () => ({ qbApiRequest: f.api }))
import { sendIntakeEstimate, intakeSummary, estimateBody, assertEstimateIdentity } from './quickbooks'

const raw = () => ({ Id: 'qb-estimate', SyncToken: '1', ...estimateBody(f.payload, 'customer-id', f.contact.customerEmail), TotalAmt: 100, DocNumber: '1001' })
beforeEach(() => {
  f.intake = { orderId: 'order', qbEstimateId: null, qbEstimateNumber: null, qbHash: null, sentHash: null, createBody: null }
  f.full = { estimate: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', priceMode: 'itemized' }, services: [{ source: 'manual', title: 'Interior detail' }] }
  f.order.status = 'estimate'
  f.contact.customerEmail = 'customer@realshop.net'
  f.api.mockReset().mockImplementation(async (opts: { path: string }) => ({ Estimate: { ...raw(), ...(opts.path.endsWith('/send') ? { EmailStatus: 'EmailSent' } : {}) } }))
})
const send = async () => sendIntakeEstimate('order', 'Manager', (await intakeSummary('order')).revision)

describe('standalone QuickBooks estimates', () => {
  it('creates and emails an Estimate, never an Invoice, and saves distinct linkage', async () => {
    await send()
    expect(f.intake.qbEstimateId).toBe('qb-estimate')
    expect(f.intake.sentAt).toBeInstanceOf(Date)
    const calls = f.api.mock.calls.map(c => c[0])
    expect(calls.every(c => !c.path.includes('invoice'))).toBe(true)
    expect(calls.find(c => c.path.endsWith('/send')).query.sendTo).toBe(f.contact.customerEmail)
    expect(f.intake).not.toHaveProperty('qbInvoiceId')
  })
  it('does not email an already-sent unchanged revision twice', async () => {
    await send(); await send()
    expect(f.api.mock.calls.filter(c => c[0].path.endsWith('/send'))).toHaveLength(1)
    expect(f.api.mock.calls.filter(c => c[0].path === '/estimate' && !c[0].body.Id)).toHaveLength(1)
  })
  it('reuses the persisted create payload and request ID after a timeout', async () => {
    f.api.mockRejectedValueOnce(new Error('timeout after QB accepted'))
    await expect(send()).rejects.toThrow('timeout')
    const first = f.api.mock.calls[0][0]
    expect(f.intake.createBody).toEqual(first.body)
    await send()
    const retry = f.api.mock.calls[1][0]
    expect(retry.body).toEqual(first.body)
    expect(retry.query.requestid).toBe(first.query.requestid)
  })
  it('retries an ambiguous send with the same request ID', async () => {
    let failed = false
    f.api.mockImplementation(async opts => {
      if (opts.path.endsWith('/send') && !failed) { failed = true; throw new Error('lost send response') }
      return { Estimate: { ...raw(), EmailStatus: 'EmailSent' } }
    })
    await expect(send()).rejects.toThrow('lost send')
    await send()
    const sends = f.api.mock.calls.filter(c => c[0].path.endsWith('/send'))
    expect(sends).toHaveLength(2)
    expect(sends[0][0].query.requestid).toBe(sends[1][0].query.requestid)
  })
  it('blocks same-total service changes made directly in QuickBooks', async () => {
    await send()
    f.api.mockResolvedValue({ Estimate: { ...raw(), Line: [{ ...raw().Line[0], Description: 'Different service' }] } })
    const calls = f.api.mock.calls.length
    await expect(send()).rejects.toThrow('changed in QuickBooks')
    expect(f.api.mock.calls.slice(calls).every(c => c[0].method !== 'POST')).toBe(true)
  })
  it('refuses a stale preview before any external writes', async () => {
    await expect(sendIntakeEstimate('order', 'Manager', 'stale')).rejects.toThrow('changed')
    expect(f.api).not.toHaveBeenCalled()
  })
  it('refuses quotes already moved to the board', async () => {
    f.order.status = 'arrived'
    await expect(send()).rejects.toThrow('Work Board')
    expect(f.api).not.toHaveBeenCalled()
  })
  it('blocks missing email and total mismatches without emailing', async () => {
    f.contact.customerEmail = ''
    await expect(send()).rejects.toThrow('email')
    expect(f.api).not.toHaveBeenCalled()
    f.contact.customerEmail = 'customer@realshop.net'
    f.api.mockResolvedValue({ Estimate: { ...raw(), TotalAmt: 999 } })
    await expect(send()).rejects.toThrow('total differs')
    expect(f.api.mock.calls.some(c => c[0].path.endsWith('/send'))).toBe(false)
  })
  it('refuses another customer or another estimate identity', () => {
    expect(() => assertEstimateIdentity(raw(), 'qb-estimate', 'wrong', 'customer-id')).toThrow('no longer matches')
    expect(() => assertEstimateIdentity(raw(), 'qb-estimate', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'wrong')).toThrow('no longer matches')
    expect(() => assertEstimateIdentity(raw(), 'different-id', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'customer-id')).toThrow('no longer matches')
  })
  it('preserves exact amounts and vehicle memo in the estimate payload', () => {
    const body = estimateBody(f.payload, 'customer-id', f.contact.customerEmail)
    expect(body.Line[0].Amount).toBe(100)
    expect(body.CustomerMemo.value).toBe('2020 Honda Civic')
    expect(body.Line[0].SalesItemLineDetail.ItemRef.value).toBe('labor')
  })
})
