import { describe, it, expect } from 'vitest'
import { classifyUnmatchedReceipt, looksJobSpecific, matchObligation, type ObligationFacts, type TxnFacts } from './reconcile'
import { expectsReceipt, isPurchaseTxnClass } from '@/apps/finance/txn-class'

describe('a receipt backs a purchase — never a cash movement', () => {
  it('card payments, transfers, payroll, loan payments and owner draws are not purchases', () => {
    for (const c of ['card_payment', 'transfer', 'payroll', 'debt_payment', 'owner_draw']) expect(isPurchaseTxnClass(c)).toBe(false)
    for (const c of ['expense', 'inventory', 'check', 'fee', null]) expect(isPurchaseTxnClass(c)).toBe(true)
  })
  it('only purchases and checks are expected to have a receipt (a bank fee is not)', () => {
    expect(expectsReceipt('expense')).toBe(true)
    expect(expectsReceipt('check')).toBe(true)
    expect(expectsReceipt('fee')).toBe(false)
    expect(expectsReceipt('card_payment')).toBe(false)
  })
})

describe('classifyUnmatchedReceipt — timing vs unavailable vs to review', () => {
  const debit = { receiptDate: '2026-11-13', funding: 'business', accountRef: '*2649', paymentMethod: 'card' }
  it('the Tesla case: bought 11/13, bank feed through 11/12 → a TIMING difference, not an error', () => {
    const c = classifyUnmatchedReceipt(debit, '2026-11-12')
    expect(c.kind).toBe('timing')
    expect(c.why).toContain('2026-11-12')
  })
  it('well inside bank coverage with no match → to review', () => {
    expect(classifyUnmatchedReceipt({ ...debit, receiptDate: '2026-10-20' }, '2026-11-12').kind).toBe('to_review')
  })
  it('cash, personal money and unconnected sources can never be seen in the bank feed', () => {
    expect(classifyUnmatchedReceipt({ ...debit, paymentMethod: 'cash', accountRef: 'cash' }, '2026-11-12').kind).toBe('source_unavailable')
    expect(classifyUnmatchedReceipt({ ...debit, funding: 'personal' }, '2026-11-12').kind).toBe('source_unavailable')
    expect(classifyUnmatchedReceipt({ ...debit, accountRef: 'other:Venmo' }, '2026-11-12').kind).toBe('source_unavailable')
    expect(classifyUnmatchedReceipt(debit, null).kind).toBe('source_unavailable')
  })
  it('an unpaid purchase has no payment yet', () => {
    expect(classifyUnmatchedReceipt({ ...debit, funding: 'unpaid' }, '2026-11-12').kind).toBe('timing')
  })
})

describe('looksJobSpecific — evidence only, never an assignment', () => {
  it('a note naming a job is evidence', () => {
    expect(looksJobSpecific({ entity: 'shared', category: 'other', memo: null, filingNote: 'Job: https://x/orders/dd38262d-18a8-4195-8cb5-92cbf515d1f8' })).toContain('customer job')
  })
  it('Detail & Service parts / outside labor is evidence', () => {
    expect(looksJobSpecific({ entity: 'detail', category: 'parts', memo: null, filingNote: null })).not.toBeNull()
    expect(looksJobSpecific({ entity: 'detail', category: 'subcontractor', memo: null, filingNote: null })).not.toBeNull()
  })
  it('bulk supplies, fuel and auto-sales purchases are not job-specific', () => {
    expect(looksJobSpecific({ entity: 'detail', category: 'shop_supplies', memo: null, filingNote: null })).toBeNull()
    expect(looksJobSpecific({ entity: 'auto_sales', category: 'parts', memo: null, filingNote: null })).toBeNull()
  })
})

describe('matchObligation — an expected bill and its actual payment are ONE payment', () => {
  const rent: ObligationFacts = { vendor: 'Wellborn Properties', category: 'rent', frequency: 'monthly', amountCents: 250000, amountMinCents: null, amountMaxCents: null, avgAmountCents: null, discoveryKey: null }
  const txn = (over: Partial<TxnFacts>): TxnFacts => ({ id: 't1', amountCents: 250000, txnDate: '2026-11-03', name: 'ACH WELLBORN PROPERTIES', merchantName: null, txnClass: 'expense', ...over })
  it('a payment inside the period is the expected bill (seen) — it is matched, not added', () => {
    const m = matchObligation(rent, [txn({})], '2026-11-13')
    expect(m.state).toBe('seen')
    if (m.state === 'seen') expect(m.txn.id).toBe('t1')
  })
  it('no payment inside the period → not seen (an item to review)', () => {
    expect(matchObligation(rent, [txn({ txnDate: '2026-09-03' })], '2026-11-13')).toEqual({ state: 'not_seen', lookbackDays: 36 })
  })
  it('a same-vendor payment with a wildly different amount is not that bill', () => {
    expect(matchObligation(rent, [txn({ amountCents: 4000 })], '2026-11-13').state).toBe('not_seen')
  })
  it('an unrelated vendor of the same amount is not that bill', () => {
    expect(matchObligation(rent, [txn({ name: 'ATMOS ENERGY' })], '2026-11-13').state).toBe('not_seen')
  })
  it('payroll bills match the bank’s payroll class (paper checks carry no vendor name)', () => {
    const payroll: ObligationFacts = { ...rent, vendor: 'Weekly payroll', category: 'payroll', frequency: 'weekly', amountCents: null }
    expect(matchObligation(payroll, [txn({ name: 'CHECK 10361', txnClass: 'payroll', amountCents: 157245, txnDate: '2026-11-10' })], '2026-11-13').state).toBe('seen')
  })
  it('an irregular bill cannot be checked and says so', () => {
    expect(matchObligation({ ...rent, frequency: 'irregular' }, [txn({})], '2026-11-13').state).toBe('cannot_check')
  })
})
