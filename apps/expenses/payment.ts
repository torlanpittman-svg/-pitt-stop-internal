import type { FundingSource, PaymentMethod } from './types'

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// SHARED payment-source registry + deterministic matcher. Defined ONCE and used by BOTH receipt workflows:
//   - general business receipts  (apps/expenses)
//   - Auto Sales per-vehicle expenses (apps/auto-sales)
// A future payment-source change (new card, new ending, new bank) is edited here and takes effect in both.
//
// The FIVE approved BUSINESS payment sources, plus Cash / Personal / Other (and "unpaid" as a secondary):
//   1. Extraco debit card       — Discover ending 1068   → Extraco checking *5600
//   2. American Momentum debit  — Mastercard ending 0022 → AMB checking *2649
//   3. American Momentum debit  — Mastercard ending 0320 → AMB checking *2649
//   4. American Momentum check  — account ending 2649
//   5. Extraco check            — account ending 5600
//
// Persistence maps onto EXISTING columns (no migration): payment_method (card|check|cash), account_ref
// (*2649|*5600|cash), and payment_last4 (the CARD ending — a string so leading zeros in 0022/0320 survive).
// cardLast4 (the card's printed last four) is stored SEPARATELY from accountEnding (the checking-account
// ending); the two are never conflated.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const OTHER_PAYMENT_MAX_LENGTH = 34

export interface PaymentSource {
  readonly key: string
  readonly label: string
  readonly funding: FundingSource
  readonly method: PaymentMethod | null
  readonly brand: 'discover' | 'mastercard' | 'visa' | 'amex' | null // the card network, when this is a card
  readonly cardLast4: string | null      // the printed CARD last-4 (identifies a specific card; ≠ account)
  readonly accountEnding: string | null  // the CHECKING-ACCOUNT last-4 (identifies the account for a check)
  readonly accountRef: string | null     // existing operational bank ref used by review + CFO
}

export const RECEIPT_PAYMENT_CHOICES: readonly PaymentSource[] = [
  { key: 'extraco_debit',  label: 'Extraco debit ••1068', funding: 'business', method: 'card',  brand: 'discover',   cardLast4: '1068', accountEnding: null,   accountRef: '*5600' },
  { key: 'amb_debit_0022', label: 'AMB debit ••0022',     funding: 'business', method: 'card',  brand: 'mastercard', cardLast4: '0022', accountEnding: null,   accountRef: '*2649' },
  { key: 'amb_debit_0320', label: 'AMB debit ••0320',     funding: 'business', method: 'card',  brand: 'mastercard', cardLast4: '0320', accountEnding: null,   accountRef: '*2649' },
  { key: 'amb_check',      label: 'AMB check ••2649',     funding: 'business', method: 'check', brand: null,         cardLast4: null,   accountEnding: '2649', accountRef: '*2649' },
  { key: 'extraco_check',  label: 'Extraco check ••5600', funding: 'business', method: 'check', brand: null,         cardLast4: null,   accountEnding: '5600', accountRef: '*5600' },
  { key: 'cash',           label: 'Cash',                 funding: 'business', method: 'cash',  brand: null,         cardLast4: null,   accountEnding: null,   accountRef: 'cash' },
  { key: 'personal',       label: 'Personal',             funding: 'personal', method: null,    brand: null,         cardLast4: null,   accountEnding: null,   accountRef: null },
  { key: 'other',          label: 'Other',                funding: 'unknown',  method: null,    brand: null,         cardLast4: null,   accountEnding: null,   accountRef: null },
] as const

/** The approved business sources only (for the deterministic match — never Cash/Personal/Other). */
const BUSINESS_SOURCES = RECEIPT_PAYMENT_CHOICES.filter((p) => p.funding === 'business' && p.accountRef)

export interface ReceiptPayment {
  funding: FundingSource
  paymentMethod: PaymentMethod | null
  accountRef: string | null
  paymentLast4: string | null    // the CARD ending for a card source (null for check/cash/other)
}

export function resolveReceiptPayment(choice: unknown, other: unknown = ''):
  { ok: true; payment: ReceiptPayment } | { ok: false; error: string } {
  // Preserve unpaid as an explicit secondary option; it is not a bank or a payment method.
  if (choice === 'unpaid') return { ok: true, payment: { funding: 'unpaid', paymentMethod: null, accountRef: null, paymentLast4: null } }
  const selected = RECEIPT_PAYMENT_CHOICES.find((p) => p.key === choice)
  if (!selected) return { ok: false, error: 'Choose how this was paid.' }
  if (choice === 'other') {
    const description = typeof other === 'string' ? other.trim() : ''
    if (!description || description.length > OTHER_PAYMENT_MAX_LENGTH || /[\x00-\x1f\x7f]/.test(description)) {
      return { ok: false, error: `Describe the payment source in 1–${OTHER_PAYMENT_MAX_LENGTH} characters.` }
    }
    // Unknown funding requires clarification; free text must never assert business-account cash flow.
    return { ok: true, payment: { funding: 'unknown', paymentMethod: null, accountRef: `other:${description}`, paymentLast4: null } }
  }
  return { ok: true, payment: { funding: selected.funding, paymentMethod: selected.method, accountRef: selected.accountRef, paymentLast4: selected.cardLast4 } }
}

/** The stored-row shape the reverse helpers read (only the fields that identify a source). */
interface StoredPayment { funding: string; paymentMethod: string | null; accountRef: string | null; paymentLast4?: string | null }

/** Reverse: which choice key a stored receipt corresponds to ('' when it maps to no current source — e.g. a
 *  historical generic *2649 card with no recorded card ending, which we must NOT retro-assign to 0022/0320). */
export function receiptPaymentChoice(r: StoredPayment): string {
  if (r.funding === 'personal' || r.funding === 'unpaid') return r.funding
  if (r.accountRef?.startsWith('other:')) return 'other'
  const last4 = r.paymentLast4 ?? null
  return RECEIPT_PAYMENT_CHOICES.find((p) =>
    p.key !== 'other' && p.funding === r.funding && p.method === r.paymentMethod && p.accountRef === r.accountRef && (p.cardLast4 ?? null) === last4,
  )?.key ?? ''
}

export function receiptPaymentLabel(r: StoredPayment): string {
  const choice = receiptPaymentChoice(r)
  if (choice === 'other') return `Other: ${r.accountRef!.slice(6)}`
  if (choice === 'unpaid') return 'Not paid yet'
  const selected = RECEIPT_PAYMENT_CHOICES.find((p) => p.key === choice)
  if (selected) return selected.label
  // Historical / generic entries: show the bank + method as recorded; never invent a specific card.
  const bank = r.accountRef && r.accountRef !== 'unknown' && !r.accountRef.startsWith('other:') ? r.accountRef : 'Account not specified'
  return [bank, r.paymentMethod].filter(Boolean).join(' · ')
}

// ── Deterministic matcher: extracted evidence → an approved source (or null). NEVER guesses an account. ──
export interface PaymentEvidence {
  method: string | null       // cash | card | check | ach | other | multiple | ...
  brand: string | null        // card network printed on the receipt, if any
  cardLast4: string | null     // the CARD's last four (never an order/date/terminal/auth/check number)
}

function normBrand(b: string | null): PaymentSource['brand'] | null {
  const s = (b ?? '').trim().toLowerCase()
  if (!s) return null
  if (/master\s*card|^mc$/.test(s)) return 'mastercard'
  if (/discover|^disc$/.test(s)) return 'discover'
  if (/visa/.test(s)) return 'visa'
  if (/amex|american\s*express/.test(s)) return 'amex'
  return null // an unrecognized brand string is treated as "no reliable brand", not a contradiction
}
function cardLast4Of(v: string | null): string | null { return typeof v === 'string' && /^\d{4}$/.test(v.trim()) ? v.trim() : null }

/**
 * Resolve receipt payment evidence to an approved source KEY, or null when it cannot be identified with
 * confidence. Rules (all deterministic; the model never supplies the mapping):
 *   - Cash is unambiguous → 'cash'.
 *   - A CARD is identified ONLY by its printed last-4 matching an approved card. An unrecognized ending →
 *     null (unknown card stays unknown, never Personal). An explicitly printed brand that CONTRADICTS the
 *     matched card leaves it unresolved. "Mastercard" alone (no last-4) cannot pick between 0022 and 0320.
 *   - A CHECK alone cannot identify the bank (a check number is not an account ending) → null.
 *   - Multiple/conflicting tenders → null (preserve uncertainty; use the exception path).
 */
export function matchPaymentSource(e: PaymentEvidence): string | null {
  const method = (e.method ?? '').trim().toLowerCase()
  if (method === 'multiple') return null
  if (method === 'cash') return 'cash'
  if (method === 'check' || method === 'ach') return null // a check/ACH alone can't identify the account
  const last4 = cardLast4Of(e.cardLast4)
  if (!last4) return null                                  // card/mastercard alone → cannot distinguish
  const card = BUSINESS_SOURCES.find((p) => p.method === 'card' && p.cardLast4 === last4)
  if (!card) return null                                   // an ending we don't recognize → unknown
  const brand = normBrand(e.brand)
  if (brand && card.brand && brand !== card.brand) return null // explicit brand contradicts the approved card
  return card.key
}

/** The bank account_ref of the matched source (or null) — the granularity Auto Sales stores per event. */
export function matchedAccountRef(e: PaymentEvidence): string | null {
  const key = matchPaymentSource(e)
  return key ? (RECEIPT_PAYMENT_CHOICES.find((p) => p.key === key)?.accountRef ?? null) : null
}
