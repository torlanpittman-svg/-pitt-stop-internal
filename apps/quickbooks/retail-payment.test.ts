import { describe, it, expect } from 'vitest'
import {
  parsePaymentMappings, availableMethods, paymentTag, parsePaymentTag, classifyInvoicePayment, isAmbiguousWriteError,
  lockIsStale, deliveredSince, linkedPaymentIds, externalMethod, parseAmountInput, validCents, summarizeInvoicePayments,
  findAttemptPayment, paymentLocksInvoice, type QbPayment,
  attemptIdForConfirmation, findConfirmationPayment, isConfirmationKey,
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

describe('"Amount received" input → integer cents (never rounded silently)', () => {
  it('accepts plain, comma, dollar-sign and short-decimal forms', () => {
    expect(parseAmountInput('2000')).toEqual({ ok: true, cents: 200000 })
    expect(parseAmountInput(' $2,000.00 ')).toEqual({ ok: true, cents: 200000 })
    expect(parseAmountInput('411')).toEqual({ ok: true, cents: 41100 })
    expect(parseAmountInput('411.5')).toEqual({ ok: true, cents: 41150 })
    expect(parseAmountInput('.05')).toEqual({ ok: true, cents: 5 })
    expect(parseAmountInput('2000.')).toEqual({ ok: true, cents: 200000 })
  })
  it('rejects empty, zero, negative, malformed and excess precision', () => {
    for (const t of ['', '  ', '0', '0.00', '-5', '1.234', '2,000.001', 'abc', '1e3', '12.3.4', '$', '+5', '99999999999999999'])
      expect(parseAmountInput(t).ok, t).toBe(false)
  })
  it('server side: only positive safe integers are cents', () => {
    expect(validCents(41100)).toBe(41100)
    for (const v of [0, -1, 1.5, '100', NaN, Infinity, null, undefined, 2 ** 60]) expect(validCents(v)).toBeNull()
  })
})

describe('invoice payment summary — money received vs credits, history per payment', () => {
  const inv = (total: number, balance: number, linked: string[]) => ({ Id: '900', TotalAmt: total, Balance: balance, LinkedTxn: linked.map((id) => ({ TxnId: id, TxnType: 'Payment' })) })
  const pay = (id: string, amt: number, note = '', extra: Partial<QbPayment> = {}): QbPayment =>
    ({ Id: id, TotalAmt: amt, PrivateNote: note, Line: [{ Amount: amt, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }], ...extra })

  it('unpaid / partial / paid follow QuickBooks Balance exactly', () => {
    expect(summarizeInvoicePayments({ invoice: inv(2411, 2411, []), payments: [], estimateId: EST })).toMatchObject({ ok: true, summary: { state: 'unpaid', receivedCents: 0 } })
    const p = summarizeInvoicePayments({ invoice: inv(2411, 411, ['1']), payments: [pay('1', 2000, paymentTag(EST, ATTEMPT, 'card_terminal'), { TxnDate: '2026-10-21' })], estimateId: EST })
    expect(p).toMatchObject({ ok: true, summary: { state: 'partial', totalCents: 241100, balanceCents: 41100, receivedCents: 200000, creditCents: 0,
      history: [{ paymentId: '1', date: '2026-10-21', appliedCents: 200000, method: 'card_terminal', source: 'pitt_stop', attemptId: ATTEMPT }] } })
    expect(summarizeInvoicePayments({ invoice: inv(2411, 0, ['1', '2']), payments: [pay('1', 2000), pay('2', 411)], estimateId: EST })).toMatchObject({ ok: true, summary: { state: 'paid', receivedCents: 241100 } })
  })
  it('a credit memo spent inside a Payment is a credit, not money received', () => {
    const credit = pay('3', 0, '', { Line: [{ Amount: 100, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }, { Amount: 100, LinkedTxn: [{ TxnId: '7', TxnType: 'CreditMemo' }] }] })
    const r = summarizeInvoicePayments({ invoice: inv(2411, 2311, ['3']), payments: [credit], estimateId: EST })
    expect(r).toMatchObject({ ok: true, summary: { receivedCents: 0, creditCents: 10000, history: [{ appliedCents: 10000, receivedCents: 0, creditCents: 10000 }] } })
  })
  it('a payment not yet listed on the invoice is shown in history but not counted toward its numbers', () => {
    const r = summarizeInvoicePayments({ invoice: inv(2411, 2411, []), payments: [pay('9', 500, paymentTag(EST, ATTEMPT, 'cash'))], estimateId: EST })
    expect(r).toMatchObject({ ok: true, summary: { state: 'unpaid', receivedCents: 0, creditCents: 0, history: [{ paymentId: '9' }] } })
  })
  it('QuickBooks method ids map back to the owner methods for payments entered in QuickBooks', () => {
    const r = summarizeInvoicePayments({ invoice: inv(2411, 2000, ['4']), payments: [pay('4', 411, 'entered in QBO', { PaymentMethodRef: { value: '2' } })], estimateId: EST, methodIds: { '2': 'check' } })
    expect(r).toMatchObject({ ok: true, summary: { history: [{ method: 'check', source: 'external' }] } })
  })
  it('missing / negative / excess balances are invalid, never guessed', () => {
    expect(summarizeInvoicePayments({ invoice: { Id: '900', TotalAmt: 10 }, payments: [], estimateId: EST }).ok).toBe(false)
    expect(summarizeInvoicePayments({ invoice: inv(10, -1, []), payments: [], estimateId: EST }).ok).toBe(false)
    expect(summarizeInvoicePayments({ invoice: inv(10, 11, []), payments: [], estimateId: EST }).ok).toBe(false)
  })
})

describe('an installment is confirmed only by its own QuickBooks payment', () => {
  const tagged = (id: string, est: string, attempt: string, amt = 500): QbPayment =>
    ({ Id: id, TotalAmt: amt, PrivateNote: paymentTag(est, attempt, 'cash'), Line: [{ Amount: amt, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }] })
  it('matches estimate + attempt + applied to this invoice — nothing else', () => {
    const other = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(findAttemptPayment([tagged('1', EST, other), tagged('2', EST, ATTEMPT)], { invoiceId: '900', estimateId: EST, attemptId: ATTEMPT })).toEqual({ paymentId: '2', appliedCents: 50000, method: 'cash' })
    expect(findAttemptPayment([tagged('1', EST, other)], { invoiceId: '900', estimateId: EST, attemptId: ATTEMPT })).toBeNull()
    expect(findAttemptPayment([tagged('1', EST, ATTEMPT)], { invoiceId: '901', estimateId: EST, attemptId: ATTEMPT })).toBeNull()
    expect(findAttemptPayment([{ Id: '5', TotalAmt: 5, PrivateNote: 'manual', Line: [{ Amount: 5, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }] }], { invoiceId: '900', estimateId: EST, attemptId: ATTEMPT })).toBeNull()
  })
})

describe('one confirmation on the phone → found again on retry, whatever attempt recorded it', () => {
  const KEY = '0c4f2a1e-7b3d-4c5e-9f60-1a2b3c4d5e6f'
  const tagged = (id: string, attempt: string): QbPayment =>
    ({ Id: id, TotalAmt: 500, PrivateNote: paymentTag(EST, attempt, 'cash'), Line: [{ Amount: 500, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }] })
  it('accepts only a lower-case UUID key', () => {
    expect(isConfirmationKey(KEY)).toBe(true)
    for (const bad of [KEY.toUpperCase(), `${KEY}-r1`, '', 'x', 42, null, undefined]) expect(isConfirmationKey(bad)).toBe(false)
  })
  it('first attempt uses the key; after the key was already used, a derived id (QuickBooks may replay a requestid)', () => {
    const rand = () => 'abcdef12-3456-7890-abcd-ef1234567890'
    expect(attemptIdForConfirmation(KEY, null, rand)).toBe(KEY)
    expect(attemptIdForConfirmation(KEY, 'some-other-attempt-id', rand)).toBe(KEY)
    expect(attemptIdForConfirmation(KEY, KEY, rand)).toBe(`${KEY}-rabcdef123456`)
    expect(attemptIdForConfirmation(KEY, `${KEY}-rabcdef123456`, rand)).toBe(`${KEY}-rabcdef123456`)
    expect(paymentTag(EST, `${KEY}-rabcdef123456`, 'cash').length).toBeLessThan(200)
  })
  it('matches the key or an id derived from it — applied to this invoice, this estimate only', () => {
    expect(findConfirmationPayment([tagged('1', KEY)], { invoiceId: '900', estimateId: EST, key: KEY })).toMatchObject({ paymentId: '1' })
    expect(findConfirmationPayment([tagged('2', `${KEY}-rabcdef123456`)], { invoiceId: '900', estimateId: EST, key: KEY })).toMatchObject({ paymentId: '2' })
    expect(findConfirmationPayment([tagged('3', ATTEMPT)], { invoiceId: '900', estimateId: EST, key: KEY })).toBeNull()
    expect(findConfirmationPayment([tagged('4', `${KEY}x`)], { invoiceId: '900', estimateId: EST, key: KEY })).toBeNull()
    expect(findConfirmationPayment([tagged('1', KEY)], { invoiceId: '901', estimateId: EST, key: KEY })).toBeNull()
  })
})

describe('invoice lock: attempt state OR money applied', () => {
  it('locks while an attempt holds it, and once any payment/credit is applied — even after a later failed attempt', () => {
    expect(paymentLocksInvoice({ status: 'none' })).toBe(false)
    expect(paymentLocksInvoice({ status: 'none', balanceState: 'unpaid' })).toBe(false)
    for (const status of ['recording', 'recorded', 'paid', 'uncertain', 'review']) expect(paymentLocksInvoice({ status })).toBe(true)
    expect(paymentLocksInvoice({ status: 'error', balanceState: 'partial' })).toBe(true)
    expect(paymentLocksInvoice({ status: 'none', balanceState: 'paid' })).toBe(true)
  })
})
