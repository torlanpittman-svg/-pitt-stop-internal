import { describe, expect, it } from 'vitest'
import { decideFiling } from './types'
import {
  RECEIPT_PAYMENT_CHOICES, resolveReceiptPayment, receiptPaymentChoice, receiptPaymentLabel,
  matchPaymentSource, matchedAccountRef, matchedCardLast4, autoSelectPayment,
} from './payment'

// ── The five approved business sources + Cash/Personal/Other, defined ONCE and shared by both workflows. ──
describe('payment registry — the five approved sources', () => {
  it('lists exactly the five business sources (2 AMB debit cards, Extraco debit, 2 checks) + cash/personal/other', () => {
    expect(RECEIPT_PAYMENT_CHOICES.map((p) => p.key)).toEqual([
      'extraco_debit', 'amb_debit_0022', 'amb_debit_0320', 'amb_check', 'extraco_check', 'cash', 'personal', 'other',
    ])
    // Card endings are stored SEPARATELY from checking-account endings — never conflated.
    const cards = RECEIPT_PAYMENT_CHOICES.filter((p) => p.method === 'card')
    expect(cards.map((c) => c.cardLast4)).toEqual(['1068', '0022', '0320'])
    expect(cards.every((c) => c.accountEnding === null)).toBe(true)
    const checks = RECEIPT_PAYMENT_CHOICES.filter((p) => p.method === 'check')
    expect(checks.map((c) => c.accountEnding)).toEqual(['2649', '5600'])
    expect(checks.every((c) => c.cardLast4 === null)).toBe(true)
  })

  it.each([
    ['extraco_debit', '*5600', 'card', '1068'], ['amb_debit_0022', '*2649', 'card', '0022'],
    ['amb_debit_0320', '*2649', 'card', '0320'], ['amb_check', '*2649', 'check', null],
    ['extraco_check', '*5600', 'check', null], ['cash', 'cash', 'cash', null],
  ])('%s resolves to the right source/instrument and round-trips (leading zeros preserved)', (key, accountRef, method, last4) => {
    const r = resolveReceiptPayment(key)
    expect(r).toEqual({ ok: true, payment: { funding: 'business', accountRef, paymentMethod: method, paymentLast4: last4 } })
    if (r.ok) expect(receiptPaymentChoice(r.payment)).toBe(key)
  })

  it('the two AMB debit cards share *2649 but are distinguished by card ending', () => {
    const a = resolveReceiptPayment('amb_debit_0022'); const b = resolveReceiptPayment('amb_debit_0320')
    if (!a.ok || !b.ok) throw new Error('fixture')
    expect(a.payment.paymentLast4).toBe('0022'); expect(b.payment.paymentLast4).toBe('0320') // leading zero kept
    expect(receiptPaymentLabel(a.payment)).toBe('AMB debit ••0022')
    expect(receiptPaymentChoice(a.payment)).toBe('amb_debit_0022')
    expect(receiptPaymentChoice(b.payment)).toBe('amb_debit_0320')
  })

  it('personal is an exception, not business cash or a recorded reimbursement', () => {
    const r = resolveReceiptPayment('personal')
    expect(r).toEqual({ ok: true, payment: { funding: 'personal', accountRef: null, paymentMethod: null, paymentLast4: null } })
    if (!r.ok) throw new Error('fixture')
    const outcome = decideFiling({ ...r.payment, entity: 'detail', category: { kind: 'single', key: 'shop_supplies' }, vendor: 'Test vendor', receiptDate: '2026-09-17', totalCents: 1200 })
    expect(outcome.reasons).toEqual(['personal_reimbursement'])
  })

  it('Other preserves text without guessing funding; unpaid is a distinct secondary path', () => {
    const r = resolveReceiptPayment('other', '  Company Amex  ')
    expect(r).toEqual({ ok: true, payment: { funding: 'unknown', paymentMethod: null, accountRef: 'other:Company Amex', paymentLast4: null } })
    if (r.ok) expect(receiptPaymentLabel(r.payment)).toBe('Other: Company Amex')
    expect(resolveReceiptPayment('unpaid')).toEqual({ ok: true, payment: { funding: 'unpaid', paymentMethod: null, accountRef: null, paymentLast4: null } })
    expect(resolveReceiptPayment('forged-account').ok).toBe(false)
  })
  it.each(['', '   ', 'x'.repeat(35), 'card\nnumber'])('rejects invalid Other text', (text) => {
    expect(resolveReceiptPayment('other', text).ok).toBe(false)
  })
})

// ── Historical / generic rows are preserved, never retro-assigned to a specific card. ──
describe('historical payment values are preserved, not reclassified', () => {
  it('a legacy generic *2649 CARD with no recorded ending maps to NO current source and shows generic', () => {
    const r = { funding: 'business', paymentMethod: 'card', accountRef: '*2649', paymentLast4: null }
    expect(receiptPaymentChoice(r)).toBe('')                        // never guessed to be 0022 or 0320
    expect(receiptPaymentLabel(r)).toBe('*2649 · card')
  })
  it('a legacy generic card with no bank shows generic', () => {
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

// ── Deterministic matcher: extracted evidence → an approved source (or null). ──
const ev = (o: Partial<{ method: string | null; brand: string | null; cardLast4: string | null; accountEnding: string | null }>) => ({ method: null, brand: null, cardLast4: null, accountEnding: null, ...o })

describe('matchPaymentSource — identifies a source only from sufficient, unambiguous evidence', () => {
  it('each approved card matches by its printed last-4 (with a consistent or absent brand)', () => {
    expect(matchPaymentSource(ev({ method: 'card', brand: 'discover', cardLast4: '1068' }))).toBe('extraco_debit')
    expect(matchPaymentSource(ev({ method: 'card', brand: 'mastercard', cardLast4: '0022' }))).toBe('amb_debit_0022')
    expect(matchPaymentSource(ev({ method: 'card', brand: 'mastercard', cardLast4: '0320' }))).toBe('amb_debit_0320')
    expect(matchPaymentSource(ev({ method: 'card', brand: null, cardLast4: '0022' }))).toBe('amb_debit_0022') // leading zero
  })
  it('cash is unambiguous → cash', () => {
    expect(matchPaymentSource(ev({ method: 'cash' }))).toBe('cash')
  })
  it('"Mastercard" alone (no last-4) cannot distinguish the two AMB cards → unresolved', () => {
    expect(matchPaymentSource(ev({ method: 'card', brand: 'mastercard', cardLast4: null }))).toBeNull()
    expect(matchPaymentSource(ev({ method: 'card', brand: null, cardLast4: null }))).toBeNull()
  })
  it('a printed brand that CONTRADICTS the approved card leaves it unresolved', () => {
    expect(matchPaymentSource(ev({ method: 'card', brand: 'visa', cardLast4: '0022' }))).toBeNull()       // 0022 is our Mastercard
    expect(matchPaymentSource(ev({ method: 'card', brand: 'mastercard', cardLast4: '1068' }))).toBeNull() // 1068 is our Discover
  })
  it('an unknown card ending stays UNKNOWN (never Personal)', () => {
    const m = matchPaymentSource(ev({ method: 'card', brand: 'visa', cardLast4: '4444' }))
    expect(m).toBeNull(); expect(m).not.toBe('personal')
  })
  it('a CHECK alone cannot identify the bank; a check number is not an account ending → unresolved', () => {
    expect(matchPaymentSource(ev({ method: 'check', brand: null, cardLast4: null }))).toBeNull()
    expect(matchPaymentSource(ev({ method: 'check', cardLast4: '1234' }))).toBeNull() // a check# never resolves a bank
  })

  it('EXPLICIT checking-account evidence (2649/5600) resolves the check source; a bare check stays unanswered', () => {
    // The paying bank account's printed last-4 identifies the checking account.
    expect(matchPaymentSource(ev({ method: 'check', accountEnding: '2649' }))).toBe('amb_check')
    expect(matchPaymentSource(ev({ method: 'check', accountEnding: '5600' }))).toBe('extraco_check')
    expect(matchPaymentSource(ev({ method: null, accountEnding: '2649' }))).toBe('amb_check')
    // A check with NO explicit account ending (only a check number lives in receiptNumber, not accountEnding) → null.
    expect(matchPaymentSource(ev({ method: 'check', accountEnding: null }))).toBeNull()
    // An unrecognized account ending → unresolved (not forced to a bank).
    expect(matchPaymentSource(ev({ method: 'check', accountEnding: '4444' }))).toBeNull()
  })

  it('a printed card last-4 takes precedence over an account ending (it is a card payment)', () => {
    expect(matchPaymentSource(ev({ method: 'card', brand: 'discover', cardLast4: '1068', accountEnding: '2649' }))).toBe('extraco_debit')
  })
  it('never matches an ACCOUNT ending or arbitrary/ malformed 4-digit strings as a card', () => {
    expect(matchPaymentSource(ev({ method: 'card', cardLast4: '2649' }))).toBeNull() // account ending ≠ card ending
    expect(matchPaymentSource(ev({ method: 'card', cardLast4: '5600' }))).toBeNull()
    expect(matchPaymentSource(ev({ method: 'card', cardLast4: '10680' }))).toBeNull()
    expect(matchPaymentSource(ev({ method: 'card', cardLast4: 'abcd' }))).toBeNull()
  })
  it('multiple / conflicting tenders preserve uncertainty → unresolved', () => {
    expect(matchPaymentSource(ev({ method: 'multiple', brand: 'mastercard', cardLast4: '0022' }))).toBeNull()
  })
  it('no evidence at all → unresolved', () => {
    expect(matchPaymentSource(ev({}))).toBeNull()
  })
})

describe('matchedAccountRef + matchedCardLast4 — Auto Sales stores card ending SEPARATELY from the bank', () => {
  it('maps a matched source to its approved account_ref, else null', () => {
    expect(matchedAccountRef(ev({ method: 'card', brand: 'mastercard', cardLast4: '0022' }))).toBe('*2649')
    expect(matchedAccountRef(ev({ method: 'card', brand: 'mastercard', cardLast4: '0320' }))).toBe('*2649')
    expect(matchedAccountRef(ev({ method: 'card', brand: 'discover', cardLast4: '1068' }))).toBe('*5600')
    expect(matchedAccountRef(ev({ method: 'check', accountEnding: '2649' }))).toBe('*2649') // check via account evidence
    expect(matchedAccountRef(ev({ method: 'card', brand: 'mastercard', cardLast4: null }))).toBeNull()
    expect(matchedAccountRef(ev({ method: 'check' }))).toBeNull()
    expect(matchedAccountRef(ev({ method: 'card', cardLast4: '9999' }))).toBeNull()
  })
  it('the card ending is 0022/0320/1068 for cards, but NULL for a check source (checks have no card)', () => {
    expect(matchedCardLast4(ev({ method: 'card', brand: 'mastercard', cardLast4: '0022' }))).toBe('0022')
    expect(matchedCardLast4(ev({ method: 'card', brand: 'mastercard', cardLast4: '0320' }))).toBe('0320')
    expect(matchedCardLast4(ev({ method: 'card', brand: 'discover', cardLast4: '1068' }))).toBe('1068')
    expect(matchedCardLast4(ev({ method: 'check', accountEnding: '2649' }))).toBeNull() // AMB check → no card ending
    expect(matchedCardLast4(ev({ method: 'card', cardLast4: '9999' }))).toBeNull()
  })
  it('the Auto-Sales display shape (bank + separate card ending) labels the specific card', () => {
    // How VehicleFolderView renders a stored expense: account_ref + card ending → "AMB debit ••0022".
    expect(receiptPaymentLabel({ funding: 'business', paymentMethod: 'card', accountRef: '*2649', paymentLast4: '0022' })).toBe('AMB debit ••0022')
    expect(receiptPaymentLabel({ funding: 'business', paymentMethod: 'card', accountRef: '*5600', paymentLast4: '1068' })).toBe('Extraco debit ••1068')
    expect(receiptPaymentLabel({ funding: 'business', paymentMethod: null, accountRef: '*2649', paymentLast4: null })).toBe('*2649') // bank only (no card)
  })
})

describe('autoSelectPayment — client guard: recognized selects, a manual choice survives a late/retry read', () => {
  it('auto-selects the recognized source when the employee has not chosen yet', () => {
    expect(autoSelectPayment('', false, 'amb_debit_0022')).toEqual({ choice: 'amb_debit_0022', auto: true })
  })
  it('a MANUAL choice is NEVER overwritten by a late/retry read (touched)', () => {
    expect(autoSelectPayment('cash', true, 'amb_debit_0022')).toEqual({ choice: 'cash', auto: false })
  })
  it('does not override an already-selected value, and no-ops when nothing was recognized', () => {
    expect(autoSelectPayment('extraco_debit', false, 'amb_debit_0022')).toEqual({ choice: 'extraco_debit', auto: false })
    expect(autoSelectPayment('', false, null)).toEqual({ choice: '', auto: false })
  })
})
