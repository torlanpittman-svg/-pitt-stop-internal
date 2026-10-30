import type { FundingSource, PaymentMethod } from './types'

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// SHARED payment-source registry + deterministic matcher. Defined ONCE and used by BOTH receipt workflows:
//   - general business receipts  (apps/expenses)
//   - Auto Sales per-vehicle expenses (apps/auto-sales)
// A future payment-source change (new card, new ending, new bank) is edited here and takes effect in both.
//
// The SIX approved BUSINESS payment sources, plus Cash / Personal / Other (and "unpaid" as a secondary):
//   1. Extraco debit card       — Discover ending 1068   → Extraco checking *5600
//   2. American Momentum debit  — Mastercard ending 0022 → AMB checking *2649
//   3. American Momentum debit  — Mastercard ending 0320 → AMB checking *2649
//   4. American Momentum check  — account ending 2649
//   5. Extraco check            — account ending 5600
//   6. Business Amex            — Amex ending 5008 (Business Platinum) → account_ref 'amex'
//
// SETTLEMENT is tracked because it changes what the money means: a debit card, a check and cash leave a
// BANK account at purchase ('bank'), while the Amex is a CREDIT line ('credit') — the expense is real now,
// but the cash leaves when the card bill is paid. Reporting keeps the two apart so "business cash out"
// never silently includes card spend. Nothing here books the card payment itself.
//
// Persistence maps onto EXISTING columns (no migration): payment_method (card|check|cash), account_ref
// (*2649|*5600|amex|cash), and payment_last4 (the CARD ending — a string so leading zeros in 0022/0320 survive).
// cardLast4 (the card's printed last four) is stored SEPARATELY from accountEnding (the checking-account
// ending); the two are never conflated.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const OTHER_PAYMENT_MAX_LENGTH = 34

// ── "Other" payment source (a real card/account that is not one of the five approved sources — e.g. the
// business Amex). The DESCRIPTION is free text and is preserved verbatim, but funding is NEVER inferred from
// it: the person says explicitly whose money it was, and, for business money, which instrument was used.
// 'unclassified' is a legitimate answer ("not sure") — it saves the receipt and leaves it clearly flagged.
export const OTHER_PAYMENT_FUNDINGS = [
  { key: 'business', label: 'Business money' },
  { key: 'personal', label: 'Personal money (reimbursement)' },
  { key: 'unclassified', label: 'Not sure — a manager will classify it' },
] as const
export type OtherPaymentFunding = (typeof OTHER_PAYMENT_FUNDINGS)[number]['key']
export function isOtherPaymentFunding(v: unknown): v is OtherPaymentFunding {
  return typeof v === 'string' && OTHER_PAYMENT_FUNDINGS.some((f) => f.key === v)
}
/** The instruments an Other BUSINESS source can be paid with (the real ones; never 'unknown'). */
export const OTHER_PAYMENT_METHODS: readonly PaymentMethod[] = ['card', 'check', 'cash', 'ach', 'other']
export function isOtherPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === 'string' && (OTHER_PAYMENT_METHODS as readonly string[]).includes(v)
}
/** The explicit answers that accompany an 'other' choice (both optional → stays unclassified). */
export interface OtherPaymentAnswers { funding?: unknown; paymentMethod?: unknown }
const OTHER_PREFIX = 'other:'

export interface PaymentSource {
  readonly key: string
  readonly label: string
  readonly funding: FundingSource
  readonly method: PaymentMethod | null
  readonly brand: 'discover' | 'mastercard' | 'visa' | 'amex' | null // the card network, when this is a card
  readonly cardLast4: string | null      // the printed CARD last-4 (identifies a specific card; ≠ account)
  readonly accountEnding: string | null  // the CHECKING-ACCOUNT last-4 (identifies the account for a check)
  readonly accountRef: string | null     // existing operational bank ref used by review + CFO
  // How the money actually leaves the business: 'bank' = at purchase (debit/check/cash); 'credit' = later,
  // when the card bill is paid; null = not a business source (personal / unclassified Other).
  readonly settlement: 'bank' | 'credit' | null
}

export const RECEIPT_PAYMENT_CHOICES: readonly PaymentSource[] = [
  { key: 'extraco_debit',  label: 'Extraco debit ••1068', funding: 'business', method: 'card',  brand: 'discover',   cardLast4: '1068', accountEnding: null,   accountRef: '*5600', settlement: 'bank' },
  { key: 'amb_debit_0022', label: 'AMB debit ••0022',     funding: 'business', method: 'card',  brand: 'mastercard', cardLast4: '0022', accountEnding: null,   accountRef: '*2649', settlement: 'bank' },
  { key: 'amb_debit_0320', label: 'AMB debit ••0320',     funding: 'business', method: 'card',  brand: 'mastercard', cardLast4: '0320', accountEnding: null,   accountRef: '*2649', settlement: 'bank' },
  { key: 'amb_check',      label: 'AMB check ••2649',     funding: 'business', method: 'check', brand: null,         cardLast4: null,   accountEnding: '2649', accountRef: '*2649', settlement: 'bank' },
  { key: 'extraco_check',  label: 'Extraco check ••5600', funding: 'business', method: 'check', brand: null,         cardLast4: null,   accountEnding: '5600', accountRef: '*5600', settlement: 'bank' },
  { key: 'amex',           label: 'Business Amex ••5008', funding: 'business', method: 'card',  brand: 'amex',       cardLast4: '5008', accountEnding: null,   accountRef: 'amex',  settlement: 'credit' },
  { key: 'cash',           label: 'Cash',                 funding: 'business', method: 'cash',  brand: null,         cardLast4: null,   accountEnding: null,   accountRef: 'cash',  settlement: 'bank' },
  { key: 'personal',       label: 'Personal',             funding: 'personal', method: null,    brand: null,         cardLast4: null,   accountEnding: null,   accountRef: null,    settlement: null },
  { key: 'other',          label: 'Other',                funding: 'unknown',  method: null,    brand: null,         cardLast4: null,   accountEnding: null,   accountRef: null,    settlement: null },
] as const

/** The approved business sources only (for the deterministic match — never Cash/Personal/Other). */
const BUSINESS_SOURCES = RECEIPT_PAYMENT_CHOICES.filter((p) => p.funding === 'business' && p.accountRef)

/** The account refs that settle on CREDIT (the Amex today) — derived from the registry, never hard-coded. */
const CREDIT_ACCOUNT_REFS: ReadonlySet<string> = new Set(
  RECEIPT_PAYMENT_CHOICES.filter((p) => p.settlement === 'credit' && p.accountRef).map((p) => p.accountRef as string),
)
/**
 * Does a stored receipt's account_ref name a CREDIT-settled source? Reporting uses this to keep business
 * card spend out of "business cash out" — the expense is real at purchase, the cash leaves on the card bill.
 */
export function isCreditSettledRef(accountRef: string | null | undefined): boolean {
  return !!accountRef && CREDIT_ACCOUNT_REFS.has(accountRef)
}

export interface ReceiptPayment {
  funding: FundingSource
  paymentMethod: PaymentMethod | null
  accountRef: string | null
  paymentLast4: string | null    // the CARD ending for a card source (null for check/cash/other)
}

export function resolveReceiptPayment(choice: unknown, other: unknown = '', answers: OtherPaymentAnswers = {}):
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
    // The description is preserved verbatim in every case. Funding comes ONLY from the explicit answer —
    // the free text is never parsed to assert business-account cash flow.
    const accountRef = `${OTHER_PREFIX}${description}`
    const funding = isOtherPaymentFunding(answers.funding) ? answers.funding : 'unclassified'
    if (funding === 'business') {
      // Business money: the instrument is captured explicitly. A missing one is NOT guessed — it is left
      // null so decideFiling() flags 'missing_payment_method' (the receipt still saves).
      const method = isOtherPaymentMethod(answers.paymentMethod) ? answers.paymentMethod : null
      return { ok: true, payment: { funding: 'business', paymentMethod: method, accountRef, paymentLast4: null } }
    }
    if (funding === 'personal') {
      // Personal money keeps the existing reimbursement-review handling; the source text is kept for context.
      return { ok: true, payment: { funding: 'personal', paymentMethod: null, accountRef, paymentLast4: null } }
    }
    // Unclassified → unknown funding, which stays flagged for a clear payment clarification.
    return { ok: true, payment: { funding: 'unknown', paymentMethod: null, accountRef, paymentLast4: null } }
  }
  return { ok: true, payment: { funding: selected.funding, paymentMethod: selected.method, accountRef: selected.accountRef, paymentLast4: selected.cardLast4 } }
}

/** The stored-row shape the reverse helpers read (only the fields that identify a source). */
interface StoredPayment { funding: string; paymentMethod: string | null; accountRef: string | null; paymentLast4?: string | null }

/** Reverse: which choice key a stored receipt corresponds to ('' when it maps to no current source — e.g. a
 *  historical generic *2649 card with no recorded card ending, which we must NOT retro-assign to 0022/0320). */
export function receiptPaymentChoice(r: StoredPayment): string {
  // An 'other:' account ref is checked FIRST: a classified Other source (business OR personal) must still
  // reopen as "Other" with its description intact, not collapse into the generic Personal choice.
  if (r.accountRef?.startsWith(OTHER_PREFIX)) return 'other'
  if (r.funding === 'personal' || r.funding === 'unpaid') return r.funding
  const last4 = r.paymentLast4 ?? null
  return RECEIPT_PAYMENT_CHOICES.find((p) =>
    p.key !== 'other' && p.funding === r.funding && p.method === r.paymentMethod && p.accountRef === r.accountRef && (p.cardLast4 ?? null) === last4,
  )?.key ?? ''
}

/** The preserved description of an 'Other' source, or null when the row is not an Other source. */
export function otherPaymentDescription(r: StoredPayment): string | null {
  return r.accountRef?.startsWith(OTHER_PREFIX) ? r.accountRef.slice(OTHER_PREFIX.length) : null
}
/** How a stored 'Other' source is classified (from the row's funding — never from its description). */
export function otherPaymentFunding(r: StoredPayment): OtherPaymentFunding {
  if (r.funding === 'business') return 'business'
  if (r.funding === 'personal') return 'personal'
  return 'unclassified'
}

export function receiptPaymentLabel(r: StoredPayment): string {
  const choice = receiptPaymentChoice(r)
  if (choice === 'other') {
    const kind = otherPaymentFunding(r)
    const detail = kind === 'business' ? ['business', r.paymentMethod].filter(Boolean).join(' ')
      : kind === 'personal' ? 'personal money'
      : 'not yet classified'
    return `Other: ${otherPaymentDescription(r)} · ${detail}`
  }
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
  accountEnding?: string | null // the PAYING BANK ACCOUNT's last four, ONLY if explicitly printed as an account
                                // (e.g. "ACCT ••2649") — a CHECK NUMBER is NOT an account ending
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
  // CARD — a printed card last-4 identifies the specific card (takes precedence over any account ending).
  const last4 = cardLast4Of(e.cardLast4)
  if (last4) {
    const card = BUSINESS_SOURCES.find((p) => p.method === 'card' && p.cardLast4 === last4)
    if (!card) return null                                   // an ending we don't recognize → unknown
    const brand = normBrand(e.brand)
    if (brand && card.brand && brand !== card.brand) return null // explicit brand contradicts the approved card
    return card.key
  }
  // CHECK — resolve a checking account ONLY from an EXPLICIT paying-account ending (2649/5600). "Check" or a
  // check number alone stays unanswered; a card method with no last-4 is never a check.
  const acct = cardLast4Of(e.accountEnding ?? null)
  if (acct && method !== 'card') {
    const check = BUSINESS_SOURCES.find((p) => p.method === 'check' && p.accountEnding === acct)
    if (check) return check.key
  }
  return null                                                // mastercard-alone / check-alone / unknown → unresolved
}

/** The card ending of the matched source (or null) — stored SEPARATELY from the bank account (Auto Sales). */
export function matchedCardLast4(e: PaymentEvidence): string | null {
  const key = matchPaymentSource(e)
  return key ? (RECEIPT_PAYMENT_CHOICES.find((p) => p.key === key)?.cardLast4 ?? null) : null
}

/**
 * PURE client autofill guard (shared by the capture screens + tests). Auto-selects the receipt-identified
 * source ONLY when the employee hasn't chosen yet — a late/retry read NEVER overwrites a manual choice.
 */
export function autoSelectPayment(current: string, touched: boolean, proposed: string | null | undefined):
  { choice: string; auto: boolean } {
  if (proposed && !touched && !current) return { choice: proposed, auto: true }
  return { choice: current, auto: false }
}

/** The bank account_ref of the matched source (or null) — the granularity Auto Sales stores per event. */
export function matchedAccountRef(e: PaymentEvidence): string | null {
  const key = matchPaymentSource(e)
  return key ? (RECEIPT_PAYMENT_CHOICES.find((p) => p.key === key)?.accountRef ?? null) : null
}
