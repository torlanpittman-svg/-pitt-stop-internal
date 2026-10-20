import { describe, it, expect } from 'vitest'
import {
  parsePaymentMappings, availableMethods, paymentTag, parsePaymentTag, classifyInvoicePayment, isAmbiguousWriteError,
  lockIsStale, deliveredSince, linkedPaymentIds, externalMethod, type QbPayment,
} from './retail-payment'
import { QBApiError, QBNotConnectedError } from './errors'

const EST = '11111111-2222-3333-4444-555555555555'
const ATTEMPT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('payment mappings — nothing is guessed', () => {
  it('maps a method only when both ids are present and numeric', () => {
    const cfg = parsePaymentMappings({ realmId: '123', cash: { paymentMethodId: '1', depositAccountId: '52' }, check: { paymentMethodId: '2' }, card_terminal: { paymentMethodId: 'x', depositAccountId: '52' } })
    expect(cfg.methods).toEqual({ cash: { paymentMethodId: '1', depositAccountId: '52' } })
    expect(cfg.realmId).toBe('123')
  })
  it('empty / malformed config → no methods', () => {
    expect(parsePaymentMappings('{}').methods).toEqual({})
    expect(parsePaymentMappings('not json').methods).toEqual({})
    expect(parsePaymentMappings(null).methods).toEqual({})
  })
  it('a mapping is usable only against the QuickBooks company it is pinned to', () => {
    const cfg = parsePaymentMappings({ realmId: '999', cash: { paymentMethodId: '1', depositAccountId: '4' } })
    expect(availableMethods(cfg, '999').find((m) => m.key === 'cash')).toMatchObject({ available: true })
    expect(availableMethods(cfg, '123').find((m) => m.key === 'cash')).toMatchObject({ available: false, reason: 'realm_mismatch' })
    expect(availableMethods(cfg, null).find((m) => m.key === 'cash')?.available).toBe(false)
    expect(availableMethods(cfg, '999').find((m) => m.key === 'check')).toMatchObject({ available: false, reason: 'not_configured' })
    // No realm pinned → nothing usable (sandbox ids can never leak into production).
    expect(availableMethods(parsePaymentMappings({ cash: { paymentMethodId: '1', depositAccountId: '4' } }), '999').every((m) => !m.available)).toBe(true)
  })
})

describe('attempt tag', () => {
  it('round-trips estimate, attempt and method', () => {
    const note = `${paymentTag(EST, ATTEMPT, 'card_terminal')} · Pitt Stop counter payment`
    expect(parsePaymentTag(note)).toEqual({ estimateId: EST, attemptId: ATTEMPT, method: 'card_terminal' })
    expect(parsePaymentTag('Paid via QuickBooks Payments: Payment ID 1')).toBeNull()
  })
})

const inv = (total: number, balance: number | undefined, linked: string[] = []) => ({ Id: '900', TotalAmt: total, Balance: balance, LinkedTxn: linked.map((id) => ({ TxnId: id, TxnType: 'Payment' })) })
const pay = (id: string, amount: number, extra: Partial<QbPayment> = {}): QbPayment => ({ Id: id, TotalAmt: amount, Line: [{ Amount: amount, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }], ...extra })

describe('classifyInvoicePayment — QuickBooks balance is the truth', () => {
  it('full balance open → unpaid', () => {
    expect(classifyInvoicePayment({ invoice: inv(212.18, 212.18), payments: [], estimateId: EST })).toEqual({ state: 'unpaid', balanceCents: 21218, totalCents: 21218 })
  })
  it('zero balance from our tagged payment → paid, attributed to the recorded method', () => {
    const s = classifyInvoicePayment({ invoice: inv(100, 0, ['77']), payments: [pay('77', 100, { PrivateNote: paymentTag(EST, ATTEMPT, 'check') })], estimateId: EST })
    expect(s).toMatchObject({ state: 'paid', source: 'pitt_stop', method: 'check', paymentId: '77', attemptId: ATTEMPT, amountCents: 10000 })
  })
  it('zero balance paid online (QuickBooks Payments) → paid, method online, adopted', () => {
    const s = classifyInvoicePayment({ invoice: inv(100, 0, ['88']), payments: [pay('88', 100, { TxnSource: 'EInvoice', PrivateNote: 'Paid via QuickBooks Payments: Payment ID 281797' })], estimateId: EST })
    expect(s).toMatchObject({ state: 'paid', source: 'external', method: 'online', paymentId: '88' })
  })
  it('zero balance recorded directly in QuickBooks → paid, method other', () => {
    expect(classifyInvoicePayment({ invoice: inv(100, 0, ['5']), payments: [pay('5', 100)], estimateId: EST })).toMatchObject({ state: 'paid', method: 'other' })
  })
  it('partially paid → partial (never topped up here)', () => {
    expect(classifyInvoicePayment({ invoice: inv(100, 40), payments: [], estimateId: EST })).toEqual({ state: 'partial', balanceCents: 4000, totalCents: 10000, paidCents: 6000 })
  })
  it('missing / negative / zero-total balances are invalid, never paid', () => {
    expect(classifyInvoicePayment({ invoice: inv(100, undefined), payments: [], estimateId: EST }).state).toBe('invalid')
    expect(classifyInvoicePayment({ invoice: inv(100, -1), payments: [], estimateId: EST }).state).toBe('invalid')
    expect(classifyInvoicePayment({ invoice: inv(0, 0), payments: [], estimateId: EST }).state).toBe('invalid')
  })
  it('a tagged payment for ANOTHER estimate is not ours', () => {
    const other = '99999999-2222-3333-4444-555555555555'
    expect(classifyInvoicePayment({ invoice: inv(100, 0, ['6']), payments: [pay('6', 100, { PrivateNote: paymentTag(other, ATTEMPT, 'cash') })], estimateId: EST })).toMatchObject({ source: 'external' })
  })
  it('linkedPaymentIds / externalMethod', () => {
    expect(linkedPaymentIds({ LinkedTxn: [{ TxnId: '1', TxnType: 'Payment' }, { TxnId: '2', TxnType: 'Estimate' }] })).toEqual(['1'])
    expect(externalMethod({ Id: '1', CreditCardPayment: {} })).toBe('online')
  })
})

describe('ambiguous write classification', () => {
  it('4xx = definite rejection; 5xx / 429 / network / timeout = ambiguous', () => {
    expect(isAmbiguousWriteError(new QBApiError(400, 'validation'))).toBe(false)
    expect(isAmbiguousWriteError(new QBApiError(403, 'forbidden'))).toBe(false)
    expect(isAmbiguousWriteError(new QBApiError(500, 'server'))).toBe(true)
    expect(isAmbiguousWriteError(new QBApiError(503, 'unavailable'))).toBe(true)
    expect(isAmbiguousWriteError(new QBApiError(429, 'throttled'))).toBe(true)
    expect(isAmbiguousWriteError(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true)
    expect(isAmbiguousWriteError(new TypeError('fetch failed'))).toBe(true)
    expect(isAmbiguousWriteError(new QBNotConnectedError())).toBe(false)
  })
})

describe('locks and delivery', () => {
  it('lockIsStale', () => {
    const now = Date.parse('2026-10-20T12:00:00Z')
    expect(lockIsStale(new Date(now - 10_000), now, 90_000)).toBe(false)
    expect(lockIsStale(new Date(now - 100_000), now, 90_000)).toBe(true)
    expect(lockIsStale(null, now, 90_000)).toBe(true)
  })
  it('deliveredSince reads DeliveryInfo (EmailStatus alone cannot tell after an earlier send)', () => {
    const since = '2026-10-20T12:00:00Z'
    expect(deliveredSince({ DeliveryInfo: { DeliveryType: 'Email', DeliveryTime: '2026-10-20T05:00:02-07:00' } }, { since, prior: null })).toBe(true)
    expect(deliveredSince({ DeliveryInfo: { DeliveryType: 'Email', DeliveryTime: '2026-10-19T05:00:00-07:00' } }, { since, prior: null })).toBe(false)
    expect(deliveredSince({}, { since, prior: null })).toBe(false)
  })
  it('a recent earlier (unpaid) email inside the skew window is NOT this send', () => {
    const since = '2026-10-20T12:00:00Z'
    const prior = '2026-10-20T11:59:57Z'   // unpaid invoice emailed 3 s before the paid send was locked
    expect(deliveredSince({ DeliveryInfo: { DeliveryTime: prior } }, { since, prior })).toBe(false)
    expect(deliveredSince({ DeliveryInfo: { DeliveryTime: prior } }, { since, prior: null })).toBe(true)   // why the baseline is needed
    expect(deliveredSince({ DeliveryInfo: { DeliveryTime: '2026-10-20T12:00:01Z' } }, { since, prior })).toBe(true)
    // Same-second as the baseline: not proof.
    expect(deliveredSince({ DeliveryInfo: { DeliveryTime: '2026-10-20T12:00:00Z' } }, { since, prior: '2026-10-20T12:00:00Z' })).toBe(false)
  })

})
