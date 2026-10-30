import { describe, expect, it } from 'vitest'
import { decideFiling } from './types'
import {
  RECEIPT_PAYMENT_CHOICES, resolveReceiptPayment, receiptPaymentChoice, receiptPaymentLabel,
  matchPaymentSource, matchedAccountRef, matchedCardLast4, autoSelectPayment,
  otherPaymentDescription, otherPaymentFunding, OTHER_PAYMENT_FUNDINGS, isCreditSettledRef,
} from './payment'

// ── The six approved business sources + Cash/Personal/Other, defined ONCE and shared by both workflows. ──
describe('payment registry — the six approved sources', () => {
  it('lists exactly the six business sources (2 AMB debit cards, Extraco debit, 2 checks, the Amex) + cash/personal/other', () => {
    expect(RECEIPT_PAYMENT_CHOICES.map((p) => p.key)).toEqual([
      'extraco_debit', 'amb_debit_0022', 'amb_debit_0320', 'amb_check', 'extraco_check', 'amex', 'cash', 'personal', 'other',
    ])
    // Card endings are stored SEPARATELY from checking-account endings — never conflated.
    const cards = RECEIPT_PAYMENT_CHOICES.filter((p) => p.method === 'card')
    expect(cards.map((c) => c.cardLast4)).toEqual(['1068', '0022', '0320', '5008'])
    expect(cards.every((c) => c.accountEnding === null)).toBe(true)
    const checks = RECEIPT_PAYMENT_CHOICES.filter((p) => p.method === 'check')
    expect(checks.map((c) => c.accountEnding)).toEqual(['2649', '5600'])
    expect(checks.every((c) => c.cardLast4 === null)).toBe(true)
  })

  it.each([
    ['extraco_debit', '*5600', 'card', '1068'], ['amb_debit_0022', '*2649', 'card', '0022'],
    ['amb_debit_0320', '*2649', 'card', '0320'], ['amb_check', '*2649', 'check', null],
    ['extraco_check', '*5600', 'check', null], ['amex', 'amex', 'card', '5008'], ['cash', 'cash', 'cash', null],
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
    if (r.ok) expect(receiptPaymentLabel(r.payment)).toBe('Other: Company Amex · not yet classified')
    expect(resolveReceiptPayment('unpaid')).toEqual({ ok: true, payment: { funding: 'unpaid', paymentMethod: null, accountRef: null, paymentLast4: null } })
    expect(resolveReceiptPayment('forged-account').ok).toBe(false)
  })
  it.each(['', '   ', 'x'.repeat(35), 'card\nnumber'])('rejects invalid Other text', (text) => {
    expect(resolveReceiptPayment('other', text).ok).toBe(false)
  })
})

// ── The business Amex is a first-class approved source, and it settles on CREDIT, not from a bank account. ──
describe('business Amex ••5008 (Business Platinum)', () => {
  const amex = () => {
    const r = resolveReceiptPayment('amex')
    if (!r.ok) throw new Error('fixture')
    return r.payment
  }

  it('resolves to the business Amex, round-trips, and labels itself', () => {
    expect(amex()).toEqual({ funding: 'business', paymentMethod: 'card', accountRef: 'amex', paymentLast4: '5008' })
    expect(receiptPaymentChoice(amex())).toBe('amex')
    expect(receiptPaymentLabel(amex())).toBe('Business Amex ••5008')
  })

  it('a complete Amex receipt FILES cleanly (it is an approved business source, not an exception)', () => {
    const d = decideFiling({ ...amex(), entity: 'detail', category: { kind: 'single', key: 'parts' }, vendor: 'Batteries Plus Bulbs #428', receiptDate: '2026-10-06', totalCents: 7901 })
    expect(d.status).toBe('filed')
    expect(d.reasons).toEqual([])
    expect(d.paymentMethod).toBe('card')
  })

  it('settles on CREDIT — it is NOT bank cash out (the other business sources are)', () => {
    expect(isCreditSettledRef('amex')).toBe(true)
    for (const ref of ['*2649', '*5600', 'cash', 'other:AMEX 5008', null, undefined, '']) {
      expect(isCreditSettledRef(ref)).toBe(false)
    }
    const settlement = (k: string) => RECEIPT_PAYMENT_CHOICES.find((p) => p.key === k)!.settlement
    expect(settlement('amex')).toBe('credit')
    for (const k of ['extraco_debit', 'amb_debit_0022', 'amb_debit_0320', 'amb_check', 'extraco_check', 'cash']) {
      expect(settlement(k)).toBe('bank')
    }
    expect(settlement('personal')).toBeNull()
    expect(settlement('other')).toBeNull()
  })

  it('a receipt printing ending 5008 now auto-matches the Amex (brand-guarded)', () => {
    expect(matchPaymentSource({ method: 'card', brand: 'Amex', cardLast4: '5008' })).toBe('amex')
    expect(matchPaymentSource({ method: 'card', brand: 'American Express', cardLast4: '5008' })).toBe('amex')
    expect(matchedAccountRef({ method: 'card', brand: null, cardLast4: '5008' })).toBe('amex')
    expect(matchedCardLast4({ method: 'card', brand: null, cardLast4: '5008' })).toBe('5008')
    // A contradicting printed brand leaves it unresolved rather than guessing.
    expect(matchPaymentSource({ method: 'card', brand: 'VISA', cardLast4: '5008' })).toBeNull()
    // "Amex" with no ending cannot pick a card on its own.
    expect(matchPaymentSource({ method: 'card', brand: 'amex', cardLast4: null })).toBeNull()
    // The other cards are unaffected.
    expect(matchPaymentSource({ method: 'card', brand: null, cardLast4: '0022' })).toBe('amb_debit_0022')
  })

  it('an Amex receipt is distinct from the free-text "Other: AMEX 5008" it replaces', () => {
    const typed = resolveReceiptPayment('other', 'AMEX 5008', { funding: 'business', paymentMethod: 'card' })
    if (!typed.ok) throw new Error('fixture')
    expect(receiptPaymentChoice(typed.payment)).toBe('other')      // historical rows keep their own shape
    expect(receiptPaymentChoice(amex())).toBe('amex')
    expect(isCreditSettledRef(typed.payment.accountRef)).toBe(false) // a free-text source makes no cash claim
  })
})

// ── An "Other" source (anything NOT one of the six approved sources) is classified EXPLICITLY. ──
describe('Other payment source — explicit business/personal classification', () => {
  const AMEX = 'AMEX 5008'

  it('business + method → business funding, the instrument, and the description preserved', () => {
    const r = resolveReceiptPayment('other', AMEX, { funding: 'business', paymentMethod: 'card' })
    expect(r).toEqual({ ok: true, payment: { funding: 'business', paymentMethod: 'card', accountRef: 'other:AMEX 5008', paymentLast4: null } })
    if (!r.ok) throw new Error('fixture')
    expect(receiptPaymentChoice(r.payment)).toBe('other')              // reopens as Other, not as a bank source
    expect(otherPaymentDescription(r.payment)).toBe(AMEX)              // survives save → reopen
    expect(otherPaymentFunding(r.payment)).toBe('business')
    expect(receiptPaymentLabel(r.payment)).toBe('Other: AMEX 5008 · business card')
  })

  it('business with a missing/forged method is flagged, never guessed', () => {
    for (const m of [undefined, '', 'unknown', 'bitcoin', 42]) {
      const r = resolveReceiptPayment('other', AMEX, { funding: 'business', paymentMethod: m })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.payment).toMatchObject({ funding: 'business', paymentMethod: null, accountRef: 'other:AMEX 5008' })
    }
    const r = resolveReceiptPayment('other', AMEX, { funding: 'business' })
    if (!r.ok) throw new Error('fixture')
    expect(decideFiling({ ...r.payment, entity: 'detail', category: { kind: 'single', key: 'parts' }, vendor: 'Batteries Plus Bulbs #428', receiptDate: '2026-10-06', totalCents: 7901 }).reasons)
      .toEqual(['missing_payment_method'])
  })

  it('personal Other keeps the reimbursement path AND the description', () => {
    const r = resolveReceiptPayment('other', AMEX, { funding: 'personal', paymentMethod: 'card' })
    expect(r).toEqual({ ok: true, payment: { funding: 'personal', paymentMethod: null, accountRef: 'other:AMEX 5008', paymentLast4: null } })
    if (!r.ok) throw new Error('fixture')
    expect(receiptPaymentChoice(r.payment)).toBe('other')              // NOT collapsed into the generic Personal choice
    expect(otherPaymentFunding(r.payment)).toBe('personal')
    expect(receiptPaymentLabel(r.payment)).toBe('Other: AMEX 5008 · personal money')
    expect(decideFiling({ ...r.payment, entity: 'detail', category: { kind: 'single', key: 'parts' }, vendor: 'Batteries Plus Bulbs #428', receiptDate: '2026-10-06', totalCents: 7901 }).reasons)
      .toEqual(['personal_reimbursement'])
  })

  it('unclassified (or a forged classification) stays unknown funding and flagged', () => {
    for (const f of [undefined, '', 'unclassified', 'business-ish', 7]) {
      const r = resolveReceiptPayment('other', AMEX, { funding: f })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.payment).toMatchObject({ funding: 'unknown', paymentMethod: null, accountRef: 'other:AMEX 5008' })
    }
    const r = resolveReceiptPayment('other', AMEX)
    if (!r.ok) throw new Error('fixture')
    expect(decideFiling({ ...r.payment, entity: 'detail', category: { kind: 'single', key: 'parts' }, vendor: 'Batteries Plus Bulbs #428', receiptDate: '2026-10-06', totalCents: 7901 }).reasons)
      .toEqual(['unresolved_payment'])
  })

  it('a classification is never inferred from the description text', () => {
    const r = resolveReceiptPayment('other', 'business debit card')   // says "business" — still unclassified
    expect(r.ok && r.payment.funding).toBe('unknown')
    expect(OTHER_PAYMENT_FUNDINGS.map((f) => f.key)).toEqual(['business', 'personal', 'unclassified'])
  })

  it('an invalid description is still rejected whatever the classification', () => {
    expect(resolveReceiptPayment('other', '  ', { funding: 'business', paymentMethod: 'card' }).ok).toBe(false)
    expect(resolveReceiptPayment('other', 'x'.repeat(35), { funding: 'personal' }).ok).toBe(false)
  })

  it('the classification answers are ignored for a real approved source', () => {
    const r = resolveReceiptPayment('amb_check', '', { funding: 'personal', paymentMethod: 'card' })
    expect(r).toEqual({ ok: true, payment: { funding: 'business', paymentMethod: 'check', accountRef: '*2649', paymentLast4: null } })
  })

  it('a plain Personal choice (no Other text) is unchanged', () => {
    const r = resolveReceiptPayment('personal')
    expect(r.ok && r.payment.accountRef).toBeNull()
    expect(receiptPaymentChoice({ funding: 'personal', paymentMethod: null, accountRef: null })).toBe('personal')
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
