import { describe, expect, it } from 'vitest'
import { decideFiling } from './types'
import { receiptPaymentChoice, receiptPaymentLabel, resolveReceiptPayment } from './payment'

describe('receipt payment sources', () => {
  it.each([
    ['amb_debit', '*2649', 'card'], ['amb_check', '*2649', 'check'],
    ['extraco_debit', '*5600', 'card'], ['extraco_check', '*5600', 'check'], ['cash', 'cash', 'cash'],
  ])('%s maps to the correct source and instrument', (key, accountRef, paymentMethod) => {
    const r = resolveReceiptPayment(key)
    expect(r).toEqual({ ok: true, payment: { funding: 'business', accountRef, paymentMethod } })
    if (r.ok) expect(receiptPaymentChoice(r.payment)).toBe(key)
  })
  it('personal is an exception, not business cash or a recorded reimbursement', () => {
    const r = resolveReceiptPayment('personal')
    expect(r).toEqual({ ok: true, payment: { funding: 'personal', accountRef: null, paymentMethod: null } })
    if (!r.ok) throw new Error('fixture')
    const outcome = decideFiling({ ...r.payment, entity: 'detail', category: { kind: 'single', key: 'shop_supplies' }, vendor: 'Test vendor', receiptDate: '2026-09-17', totalCents: 1200 })
    expect(outcome.reasons).toEqual(['personal_reimbursement'])
  })
  it('Other preserves text without guessing funding, and remains reviewable', () => {
    const r = resolveReceiptPayment('other', '  Company Amex  ')
    expect(r).toEqual({ ok: true, payment: { funding: 'unknown', paymentMethod: null, accountRef: 'other:Company Amex' } })
    if (r.ok) expect(receiptPaymentLabel(r.payment)).toBe('Other: Company Amex')
  })
  it.each(['', '   ', 'x'.repeat(35), 'card\nnumber'])('rejects invalid Other text', (text) => {
    expect(resolveReceiptPayment('other', text).ok).toBe(false)
  })
  it('rejects unknown choice IDs and preserves the unpaid path', () => {
    expect(resolveReceiptPayment('forged-account').ok).toBe(false)
    expect(resolveReceiptPayment('unpaid')).toEqual({ ok: true, payment: { funding: 'unpaid', paymentMethod: null, accountRef: null } })
  })
  it('does not infer a bank from a historical generic card', () => {
    const r = { funding: 'business', paymentMethod: 'card', accountRef: null }
    expect(receiptPaymentChoice(r)).toBe('')
    expect(receiptPaymentLabel(r)).toBe('Account not specified · card')
  })
  it('unknown historical payment is not mistaken for a typed Other source', () => {
    const r = { funding: 'unknown', paymentMethod: null, accountRef: null }
    expect(receiptPaymentChoice(r)).toBe('')
    expect(receiptPaymentLabel(r)).toBe('Account not specified')
  })
})
