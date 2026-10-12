import { describe, it, expect } from 'vitest'
import { decideRecovery, type WrittenCheck } from './qb-check'

const expected = { bankAccountId: '31', vendorId: 'V1', amountCents: 12345, txnDate: '2026-10-12' }
const qb = (over: Partial<WrittenCheck> = {}): WrittenCheck => ({
  purchaseId: 'P1', docNumber: '20000', syncToken: '0', totalCents: 12345, bankAccountId: '31', vendorId: 'V1', txnDate: '2026-10-12', ...over,
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
    ['a different date', { txnDate: '2026-09-01' }],
  ])('REFUSES (never adopts, never duplicates the number) when the same-bank check has %s', (_l, over) => {
    expect(decideRecovery([qb(over)], expected).action).toBe('conflict')
  })
  it('ignores the same number on a different bank account (separate check stock) and creates', () => {
    expect(decideRecovery([qb({ bankAccountId: '48' })], expected)).toEqual({ action: 'create' })
  })
  it('refuses when the match is ambiguous', () => {
    expect(decideRecovery([qb(), qb({ purchaseId: 'P2' })], expected).action).toBe('conflict')
    expect(decideRecovery([qb(), qb({ purchaseId: 'P2', totalCents: 1 })], expected).action).toBe('conflict')
  })
})
