import { vi, describe, it, expect, beforeEach } from 'vitest'

// The shared QuickBooks client is mocked — nothing here reaches QuickBooks.
const h = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/apps/quickbooks/client', () => ({ qbApiRequest: h.request, queryQBO: vi.fn(), qboEscape: (s: string) => s }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { createCheckInQB, decideRecovery, type CreateCheckParams, type WrittenCheck } from './qb-check'

const params = (over: Partial<CreateCheckParams> = {}): CreateCheckParams => ({
  bankAccountId: '31', expenseAccountId: '77', vendorId: 'V1', payeeType: 'Vendor', amountCents: 100, docNumber: '20000',
  txnDate: '2026-10-13', memo: '  Test memo  ', requestId: 'check-req-1', ...over,
})
/** The request exactly as it goes over the wire (undefined keys dropped, like JSON.stringify does). */
const sent = () => JSON.parse(JSON.stringify(h.request.mock.calls[0][0]))

describe('createCheckInQB — sends only properties QuickBooks supports on a Purchase/Check', () => {
  beforeEach(() => {
    h.request.mockReset().mockResolvedValue({
      Purchase: { Id: 'P9', DocNumber: '20000', SyncToken: '0', TotalAmt: 1, TxnDate: '2026-10-13', PaymentType: 'Check', AccountRef: { value: '31' }, EntityRef: { value: 'V1', type: 'Vendor' } },
    })
  })

  it('serializes the complete Purchase payload: payee at the top level only, expense line with AccountRef only', async () => {
    const written = await createCheckInQB(params())
    expect(h.request).toHaveBeenCalledTimes(1)
    expect(sent()).toEqual({
      method: 'POST',
      path: '/purchase',
      query: { requestid: 'check-req-1' },
      body: {
        PaymentType: 'Check',
        AccountRef: { value: '31' },
        EntityRef: { value: 'V1', type: 'Vendor' },
        DocNumber: '20000',
        TxnDate: '2026-10-13',
        PrivateNote: 'Test memo',
        Line: [
          {
            DetailType: 'AccountBasedExpenseLineDetail',
            Amount: 1,
            Description: 'Test memo',
            AccountBasedExpenseLineDetail: { AccountRef: { value: '77' } },
          },
        ],
      },
    })
    expect(written).toEqual({ purchaseId: 'P9', docNumber: '20000', syncToken: '0', totalCents: 100, bankAccountId: '31', vendorId: 'V1', payeeType: 'Vendor', txnDate: '2026-10-13' })
  })

  it('never nests EntityRef inside AccountBasedExpenseLineDetail (QuickBooks rejects it: 400 code 2010)', async () => {
    await createCheckInQB(params())
    const { body } = sent()
    expect(body.Line).toHaveLength(1)
    expect(Object.keys(body.Line[0].AccountBasedExpenseLineDetail)).toEqual(['AccountRef'])
    expect(body.Line[0].AccountBasedExpenseLineDetail).not.toHaveProperty('EntityRef')
    expect(body.EntityRef).toEqual({ value: 'V1', type: 'Vendor' })
  })

  it.each([['Employee', '400000021'], ['Customer', '215']] as const)('pays an existing QuickBooks %s by its own id and type (never as a Vendor)', async (type, id) => {
    await createCheckInQB(params({ vendorId: id, payeeType: type }))
    expect(sent().body.EntityRef).toEqual({ value: id, type })
  })

  it.each([[100, 1], [12345, 123.45], [1999, 19.99], [5, 0.05], [100001, 1000.01]])('sends %i cents as exactly %d dollars', async (cents, dollars) => {
    await createCheckInQB(params({ amountCents: cents }))
    expect(sent().body.Line[0].Amount).toBe(dollars)
  })

  it('reuses the same requestid when the same check is sent again', async () => {
    await createCheckInQB(params())
    await createCheckInQB(params())
    expect(h.request.mock.calls.map((c) => c[0].query)).toEqual([{ requestid: 'check-req-1' }, { requestid: 'check-req-1' }])
  })

  it('omits the memo fields when there is no memo, and prefers an explicit line description', async () => {
    await createCheckInQB(params({ memo: null }))
    expect(sent().body).not.toHaveProperty('PrivateNote')
    expect(sent().body.Line[0]).not.toHaveProperty('Description')
    h.request.mockClear()
    await createCheckInQB(params({ lineDescription: ' Shop supplies ' }))
    expect(sent().body.Line[0].Description).toBe('Shop supplies')
    expect(sent().body.PrivateNote).toBe('Test memo')
  })
})

const expected = { bankAccountId: '31', vendorId: 'V1', payeeType: 'Vendor' as const, amountCents: 12345, txnDate: '2026-10-12' }
const qb = (over: Partial<WrittenCheck> = {}): WrittenCheck => ({
  purchaseId: 'P1', docNumber: '20000', syncToken: '0', totalCents: 12345, bankAccountId: '31', vendorId: 'V1', payeeType: 'Vendor', txnDate: '2026-10-12', ...over,
})

describe('decideRecovery — only an unmistakable match is ever adopted', () => {
  it('creates when QuickBooks has nothing with this number', () => {
    expect(decideRecovery([], expected)).toEqual({ action: 'create' })
  })
  it('adopts the single Purchase that matches bank + payee + amount + date (crash recovery)', () => {
    expect(decideRecovery([qb()], expected)).toEqual({ action: 'adopt', check: qb() })
  })
  it.each([
    ['a different amount', { totalCents: 99999 }],
    ['a different payee', { vendorId: 'V2' }],
    ['the same payee id on a different QuickBooks list', { payeeType: 'Employee' }],
    ['a different date', { txnDate: '2026-09-01' }],
  ])('REFUSES (never adopts, never duplicates the number) when the same-bank check has %s', (_l, over) => {
    expect(decideRecovery([qb(over)], expected).action).toBe('conflict')
  })
  it('adopts an employee check only when the type matches too', () => {
    const emp = { ...expected, vendorId: '400000021', payeeType: 'Employee' as const }
    expect(decideRecovery([qb({ vendorId: '400000021', payeeType: 'Employee' })], emp).action).toBe('adopt')
    expect(decideRecovery([qb({ vendorId: '400000021', payeeType: 'Vendor' })], emp).action).toBe('conflict')
  })
  it('ignores the same number on a different bank account (separate check stock) and creates', () => {
    expect(decideRecovery([qb({ bankAccountId: '48' })], expected)).toEqual({ action: 'create' })
  })
  it('refuses when the match is ambiguous', () => {
    expect(decideRecovery([qb(), qb({ purchaseId: 'P2' })], expected).action).toBe('conflict')
    expect(decideRecovery([qb(), qb({ purchaseId: 'P2', totalCents: 1 })], expected).action).toBe('conflict')
  })
})
