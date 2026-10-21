/**
 * Retail Record Payment — PURE rules (no IO). The orchestration lives in retail-payment-service.ts.
 *
 * A counter payment records money ALREADY collected (cash / card terminal / check) as a QuickBooks
 * Payment applied to the job's existing invoice. It never charges a card. QuickBooks is the money
 * system of record: "paid" means QuickBooks reports a zero balance, nothing less.
 */
import { QBApiError } from './errors'

export const PAYMENT_METHODS = ['cash', 'card_terminal', 'check'] as const
export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number]
/** What a recorded/adopted payment is shown as. online/other = paid outside Record Payment. */
export type PaidMethod = PaymentMethodKey | 'online' | 'other'

export const PAID_METHOD_LABEL: Record<PaidMethod, string> = {
  cash: 'Cash', card_terminal: 'Card Terminal', check: 'Check', online: 'Paid online', other: 'Recorded in QuickBooks',
}

export const isPaymentMethodKey = (v: unknown): v is PaymentMethodKey =>
  typeof v === 'string' && (PAYMENT_METHODS as readonly string[]).includes(v)

/** Payment ATTEMPT states in which the linked invoice must not be rewritten (Sync / fee changes).
 *  'recorded' = the latest installment is confirmed in QuickBooks and a balance remains. */
export const PAYMENT_LOCKS_INVOICE: readonly string[] = ['recording', 'paid', 'uncertain', 'review', 'recorded']

/** QuickBooks-confirmed aggregate state of the invoice (job_estimates.qb_payment_balance_state). Separate from
 *  the attempt state above: a later attempt failing never makes a partially paid invoice look unpaid. */
export type InvoiceBalanceState = 'unpaid' | 'partial' | 'paid'
/** Once any payment or credit is applied, the agreed total is never rewritten from Pitt Stop. */
export const BALANCE_LOCKS_INVOICE: readonly string[] = ['partial', 'paid']

/** Is the linked invoice frozen by payment state (attempt in progress/recorded, or money already applied)? */
export function paymentLocksInvoice(p: { status: string; balanceState?: string | null }): boolean {
  return PAYMENT_LOCKS_INVOICE.includes(p.status) || (!!p.balanceState && BALANCE_LOCKS_INVOICE.includes(p.balanceState))
}

/**
 * "Amount received" as typed on the phone → integer cents. Accepts "2000", "2,000", "$2,000.5", "411.00".
 * Rejects empty, zero, negative, non-numeric, and more than two decimal places (never rounded silently).
 */
export function parseAmountInput(text: string): { ok: true; cents: number } | { ok: false; error: string } {
  const raw = text.trim().replace(/^\$/, '').trim()
  if (!raw) return { ok: false, error: 'Enter the amount received.' }
  const malformed = { ok: false as const, error: 'Enter dollars and cents, e.g. 2,000.00.' }
  if ((raw.match(/\./g) ?? []).length > 1) return malformed
  const dot = raw.indexOf('.')
  const wholeRaw = dot === -1 ? raw : raw.slice(0, dot)
  const frac = dot === -1 ? '' : raw.slice(dot + 1)
  if (!/^\d*$/.test(frac)) return malformed   // no commas or stray characters in the cents
  // The dollar part is bare digits, or comma-grouped strictly in threes ("2,000", "1,234,567") — validate the
  // grouping BEFORE stripping commas, so "20,00" / ",000" / "1,2345" are rejected rather than silently read.
  const whole = wholeRaw === '' ? ''
    : wholeRaw.includes(',') ? (/^\d{1,3}(,\d{3})+$/.test(wholeRaw) ? wholeRaw.replace(/,/g, '') : null)
    : (/^\d+$/.test(wholeRaw) ? wholeRaw : null)
  if (whole === null) return malformed
  if (whole === '' && frac === '') return malformed
  if (frac.length > 2) return { ok: false, error: 'Use at most two decimal places (cents).' }
  const cents = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0') || '0')
  if (!Number.isSafeInteger(cents) || cents <= 0) return { ok: false, error: 'The amount must be more than $0.00.' }
  return { ok: true, cents }
}

/** Server-side: a positive whole number of cents, or null (malformed / zero / negative / fractional). */
export function validCents(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}

/** A 'recording' lock older than this is treated as an interrupted attempt (reconcile, then retry). */
export const RECORDING_STALE_MS = 90_000
/** Same for a 'sending' paid-invoice email. */
export const SENDING_STALE_MS = 90_000
/** QuickBooks write timeout. An abort is an AMBIGUOUS outcome — always reconciled before any retry. */
export const PAYMENT_WRITE_TIMEOUT_MS = 25_000

// ── Owner-confirmed mappings (settings: retail_payment_mappings) ─────────────────────────────
export interface MethodMapping { paymentMethodId: string; depositAccountId: string }
export interface PaymentMappings { realmId: string | null; methods: Partial<Record<PaymentMethodKey, MethodMapping>> }

const id = (v: unknown): string | null => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  return /^[0-9]{1,20}$/.test(s) ? s : null
}

/**
 * Parse the mapping setting. Fail closed: a method is mapped only when BOTH the QuickBooks
 * PaymentMethod id and the deposit (clearing) account id are present and numeric. Nothing is
 * defaulted or guessed — an empty config means no method can be recorded.
 */
export function parsePaymentMappings(raw: unknown): PaymentMappings {
  let obj: unknown = raw
  if (typeof raw === 'string') { try { obj = JSON.parse(raw || '{}') } catch { obj = {} } }
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>
  const methods: PaymentMappings['methods'] = {}
  for (const k of PAYMENT_METHODS) {
    const m = o[k] as Record<string, unknown> | undefined
    const pm = id(m?.paymentMethodId), acct = id(m?.depositAccountId)
    if (pm && acct) methods[k] = { paymentMethodId: pm, depositAccountId: acct }
  }
  return { realmId: id(o.realmId), methods }
}

export type MethodAvailability = { key: PaymentMethodKey; label: string; available: boolean; reason?: 'not_configured' | 'realm_mismatch' }

/**
 * Which methods may be recorded against the CONNECTED QuickBooks company. The mapping must be pinned to
 * that company's realm id, so sandbox ids can never be used against production (or vice versa).
 */
export function availableMethods(cfg: PaymentMappings, connectedRealmId: string | null): MethodAvailability[] {
  const realmOk = !!cfg.realmId && !!connectedRealmId && cfg.realmId === connectedRealmId
  return PAYMENT_METHODS.map((key) => {
    const label = PAID_METHOD_LABEL[key]
    if (!cfg.methods[key]) return { key, label, available: false, reason: 'not_configured' as const }
    if (!realmOk) return { key, label, available: false, reason: 'realm_mismatch' as const }
    return { key, label, available: true }
  })
}

// ── Attempt tag (PrivateNote) — identifies a Pitt Stop payment and its attempt ───────────────
const TAG_RE = /PSPAY:([0-9a-f-]{36}):([A-Za-z0-9-]{8,80}):(cash|card_terminal|check)/

export function paymentTag(estimateId: string, attemptId: string, method: PaymentMethodKey): string {
  return `PSPAY:${estimateId}:${attemptId}:${method}`
}
export function parsePaymentTag(note: string | null | undefined): { estimateId: string; attemptId: string; method: PaymentMethodKey } | null {
  const m = TAG_RE.exec(note ?? '')
  return m ? { estimateId: m[1], attemptId: m[2], method: m[3] as PaymentMethodKey } : null
}

// ── Reading QuickBooks payment state ─────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface QbPayment {
  Id: string; TotalAmt?: number; PrivateNote?: string; TxnSource?: string; TxnDate?: string
  PaymentMethodRef?: { value?: string }; CreditCardPayment?: unknown
  Line?: Array<{ Amount?: number; LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }> }>
  MetaData?: { CreateTime?: string }
  [k: string]: any
}

const cents = (d: number | undefined | null) => Math.round((d ?? 0) * 100)

/** Payment ids QuickBooks lists as applied to this invoice (Invoice.LinkedTxn, TxnType=Payment). */
export function linkedPaymentIds(invoice: { LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }> }): string[] {
  return (invoice.LinkedTxn ?? []).filter((t) => t.TxnType === 'Payment' && t.TxnId).map((t) => String(t.TxnId))
}

/** Amount of a payment applied to one invoice. */
export function appliedToInvoiceCents(p: QbPayment, invoiceId: string): number {
  let sum = 0
  for (const l of p.Line ?? []) {
    if ((l.LinkedTxn ?? []).some((t) => t.TxnType === 'Invoice' && String(t.TxnId) === String(invoiceId))) sum += cents(l.Amount)
  }
  return sum
}

/** How a payment we did not record ourselves is labeled. */
export function externalMethod(p: QbPayment): PaidMethod {
  const viaQbPayments = p.TxnSource === 'EInvoice' || !!p.CreditCardPayment || /paid via quickbooks payments/i.test(p.PrivateNote ?? '')
  return viaQbPayments ? 'online' : 'other'
}

export type InvoicePaymentState =
  | { state: 'unpaid'; balanceCents: number; totalCents: number }
  | { state: 'paid'; totalCents: number; paymentId: string | null; method: PaidMethod; source: 'pitt_stop' | 'external'; attemptId: string | null; amountCents: number }
  | { state: 'partial'; balanceCents: number; totalCents: number; paidCents: number }
  | { state: 'invalid'; reason: string }

/**
 * Classify the invoice from QuickBooks' own numbers. Paid ⇔ Balance is exactly 0 on a positive total.
 * A payment we tagged (PSPAY:<estimateId>) wins the attribution; otherwise the largest applied payment
 * is the one shown (paid online / recorded directly in QuickBooks).
 */
export function classifyInvoicePayment(params: {
  invoice: { Id: string; TotalAmt?: number; Balance?: number }
  payments: QbPayment[]
  estimateId: string
}): InvoicePaymentState {
  const { invoice, payments, estimateId } = params
  const totalCents = cents(invoice.TotalAmt)
  if (invoice.Balance === undefined || invoice.Balance === null) return { state: 'invalid', reason: 'QuickBooks did not report a balance for this invoice.' }
  const balanceCents = cents(invoice.Balance)
  if (totalCents <= 0) return { state: 'invalid', reason: 'This invoice has no amount due in QuickBooks.' }
  if (balanceCents < 0) return { state: 'invalid', reason: 'QuickBooks reports a negative balance on this invoice.' }
  if (balanceCents === totalCents) return { state: 'unpaid', balanceCents, totalCents }
  if (balanceCents > totalCents) return { state: 'invalid', reason: 'QuickBooks balance exceeds the invoice total.' }
  if (balanceCents > 0) return { state: 'partial', balanceCents, totalCents, paidCents: totalCents - balanceCents }

  const applied = payments
    .map((p) => ({ p, amount: appliedToInvoiceCents(p, invoice.Id), tag: parsePaymentTag(p.PrivateNote) }))
    .filter((x) => x.amount > 0)
  const ours = applied.find((x) => x.tag && x.tag.estimateId === estimateId)
  if (ours) return { state: 'paid', totalCents, paymentId: String(ours.p.Id), method: ours.tag!.method, source: 'pitt_stop', attemptId: ours.tag!.attemptId, amountCents: ours.amount }
  const top = applied.sort((a, b) => b.amount - a.amount)[0]
  // Zero balance with no readable payment (e.g. a credit memo applied) — still paid per QuickBooks.
  return { state: 'paid', totalCents, paymentId: top ? String(top.p.Id) : null, method: top ? externalMethod(top.p) : 'other', source: 'external', attemptId: null, amountCents: top?.amount ?? totalCents }
}

// ── Installments: per-payment history and per-attempt confirmation ──────────────────────────
export interface PaymentHistoryEntry {
  paymentId: string
  /** QuickBooks TxnDate (or create time). */
  date: string | null
  /** Applied to THIS invoice. */
  appliedCents: number
  /** Money received (applied minus any credit memo / other credit used by the same Payment). */
  receivedCents: number
  creditCents: number
  method: PaidMethod
  source: 'pitt_stop' | 'external'
  attemptId: string | null
}
export interface InvoiceBalanceSummary {
  state: InvoiceBalanceState
  totalCents: number
  balanceCents: number
  /** Money received by Payments, as listed on the invoice. */
  receivedCents: number
  /** Everything else that reduced the balance — credit memos, other credits/adjustments. Never counted as cash. */
  creditCents: number
  history: PaymentHistoryEntry[]
  /** The invoice balance already reflects every Payment QuickBooks reports applied to it. False ⇒ a read is
   *  lagging (a payment is visible but the balance hasn't absorbed it): a fresh installment must not be recorded
   *  against it (a retry of a known attempt, matched by its tag, is unaffected). */
  coherent: boolean
}

/**
 * The invoice's payment picture from QuickBooks' own numbers. Paid ⇔ Balance is exactly 0. Each Payment's
 * money vs. credit portion is kept apart (a credit memo applied through a Payment is not cash collected).
 * Reconciliation is evidence-based: a balance drop is attributed to the Payments we actually read, and to a
 * credit ONLY where one is linked — an unexplained drop (a Payment the invoice lists but we couldn't read, or
 * one not matched by any evidence) is REFUSED (ok:false), never silently reported as a credit. `methodIds` maps
 * the owner's QuickBooks PaymentMethod ids back to Cash / Check / Card Terminal for payments entered in QuickBooks.
 */
export function summarizeInvoicePayments(params: {
  invoice: { Id: string; TotalAmt?: number; Balance?: number; LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }> }
  payments: QbPayment[]
  estimateId: string
  methodIds?: Record<string, PaymentMethodKey>
}): { ok: true; summary: InvoiceBalanceSummary } | { ok: false; reason: string } {
  const { invoice, payments, estimateId } = params
  if (invoice.Balance === undefined || invoice.Balance === null) return { ok: false, reason: 'QuickBooks did not report a balance for this invoice.' }
  const totalCents = cents(invoice.TotalAmt), balanceCents = cents(invoice.Balance)
  if (totalCents <= 0) return { ok: false, reason: 'This invoice has no amount due in QuickBooks.' }
  if (balanceCents < 0) return { ok: false, reason: 'QuickBooks reports a negative balance on this invoice.' }
  if (balanceCents > totalCents) return { ok: false, reason: 'QuickBooks balance exceeds the invoice total.' }

  // Only an authoritative credit link counts as a credit. A CreditMemo is a credit; any OTHER non-Payment link
  // (Estimate, TimeActivity, …) is NOT evidence of one and must never let an unexplained reduction be called credit.
  const isCreditTxn = (t: string | undefined) => t === 'CreditMemo'
  const linked = new Set(linkedPaymentIds(invoice))
  const linkedCredit = (invoice.LinkedTxn ?? []).some((t) => isCreditTxn(t.TxnType))
  const history: PaymentHistoryEntry[] = []
  const appliedIds = new Set<string>()   // linked Payments we actually read AND that positively allocate here
  let appliedSum = 0        // all read Payments' amounts applied to THIS invoice (coherence vs. the balance drop)
  let receivedByPayments = 0, creditByPayments = 0
  for (const p of payments) {
    const applied = appliedToInvoiceCents(p, invoice.Id)
    if (applied <= 0) continue
    appliedSum += applied
    appliedIds.add(String(p.Id))
    // Distinct invoices this one Payment pays, and the recognized CREDIT lines inside it (credit memos).
    const invoices = new Set<string>()
    let otherLines = 0
    for (const l of p.Line ?? []) {
      const txns = l.LinkedTxn ?? []
      for (const t of txns) if (t.TxnType === 'Invoice' && t.TxnId) invoices.add(String(t.TxnId))
      if (txns.some((t) => isCreditTxn(t.TxnType))) otherLines += cents(l.Amount)
    }
    // Cash vs. credit split for THIS invoice: clean when the Payment pays only this invoice (or has no credit).
    // A Payment spreading credit across SEVERAL invoices has no determinable per-invoice split — don't invent one.
    let credit: number
    if (otherLines <= 0) credit = 0
    else if (invoices.size <= 1) credit = Math.min(applied, otherLines)
    else return { ok: false, reason: 'A QuickBooks payment applies a credit across more than one invoice — the amount received on this invoice can’t be determined here. Review it in QuickBooks.' }
    receivedByPayments += applied - credit
    creditByPayments += credit
    const tag = parsePaymentTag(p.PrivateNote)
    const ours = !!tag && tag.estimateId === estimateId
    const pm = p.PaymentMethodRef?.value != null ? params.methodIds?.[String(p.PaymentMethodRef.value)] : undefined
    const ext = externalMethod(p)
    history.push({
      paymentId: String(p.Id), date: p.TxnDate ?? p.MetaData?.CreateTime ?? null,
      appliedCents: applied, receivedCents: applied - credit, creditCents: credit,
      method: ours ? tag!.method : ext === 'other' && pm ? pm : ext,
      source: ours ? 'pitt_stop' : 'external', attemptId: ours ? tag!.attemptId : null,
    })
  }
  // Every Payment the invoice LISTS must have been read AND positively allocate to this invoice; otherwise the
  // read is incomplete (a dropped balance behind it is not evidence of a credit). Fail closed, don't guess.
  for (const id of linked) if (!appliedIds.has(id)) return { ok: false, reason: 'A payment listed on this invoice could not be read or does not apply to it — the balance can’t be reconciled right now. Try again, or review it in QuickBooks.' }
  history.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || Number(a.paymentId) - Number(b.paymentId))
  const reduced = totalCents - balanceCents
  const state: InvoiceBalanceState = balanceCents === 0 ? 'paid' : balanceCents === totalCents ? 'unpaid' : 'partial'
  // Reconcile the balance drop against the Payments we actually read, by EVIDENCE — never fill an unexplained
  // gap by calling it "credit".
  //   drop === payments applied → fully explained (received = payments' cash, credit = payments' credit memos);
  //   drop  >  payments applied → extra reduction: a credit ONLY if the invoice links one, else unexplained
  //                               (a missing/unread Payment) → refuse, don't guess;
  //   drop  <  payments applied → a Payment is visible the balance hasn't absorbed (lagging read) → not coherent,
  //                               report only what the balance reflects, never as credit.
  const extra = reduced - appliedSum
  let receivedCents: number, creditCents: number, coherent: boolean
  if (extra === 0) {
    receivedCents = receivedByPayments; creditCents = creditByPayments; coherent = true
  } else if (extra > 0) {
    if (!linkedCredit) return { ok: false, reason: 'The invoice balance is lower than its payments explain and no credit is linked — it can’t be reconciled right now. Review it in QuickBooks.' }
    receivedCents = receivedByPayments; creditCents = creditByPayments + extra; coherent = true
  } else {
    receivedCents = Math.min(reduced, receivedByPayments); creditCents = Math.max(0, reduced - receivedCents); coherent = false
  }
  return { ok: true, summary: { state, totalCents, balanceCents, receivedCents, creditCents, history, coherent } }
}

/**
 * The QuickBooks Payment created by ONE Pitt Stop attempt (PSPAY tag with this estimate + attempt id) and
 * applied to this invoice. This — not a balance reduction, which another payment could cause — is what
 * confirms an installment.
 */
export function findAttemptPayment(payments: QbPayment[], params: { invoiceId: string; estimateId: string; attemptId: string }): { paymentId: string; appliedCents: number; method: PaymentMethodKey } | null {
  for (const p of payments) {
    const tag = parsePaymentTag(p.PrivateNote)
    if (!tag || tag.estimateId !== params.estimateId || tag.attemptId !== params.attemptId) continue
    const applied = appliedToInvoiceCents(p, params.invoiceId)
    if (applied > 0) return { paymentId: String(p.Id), appliedCents: applied, method: tag.method }
  }
  return null
}

/** A phone-generated confirmation key (one per Review → Save): a lower-case UUID. Anything else is ignored. */
const CONFIRMATION_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const isConfirmationKey = (v: unknown): v is string => typeof v === 'string' && CONFIRMATION_KEY_RE.test(v)

/** The attempt id for a NEW attempt of one confirmation: the key itself, or — when the key's own attempt
 *  already failed definitively (QuickBooks may replay a requestid's original response) — `<key>-r<hex>`. Both
 *  stay findable by the key (findConfirmationPayment). */
export function attemptIdForConfirmation(key: string, lastAttemptId: string | null | undefined, rand: () => string): string {
  return lastAttemptId === key || lastAttemptId?.startsWith(`${key}-`) ? `${key}-r${rand().replace(/-/g, '').slice(0, 12)}` : key
}

/**
 * The QuickBooks Payment already recorded for ONE confirmation the person made (any attempt id derived from
 * its key) and applied to this invoice — a retried Save after a lost response finds it instead of recording
 * the same money twice.
 */
export function findConfirmationPayment(payments: QbPayment[], params: { invoiceId: string; estimateId: string; key: string }): { paymentId: string; appliedCents: number; method: PaymentMethodKey } | null {
  for (const p of payments) {
    const tag = parsePaymentTag(p.PrivateNote)
    if (!tag || tag.estimateId !== params.estimateId) continue
    if (tag.attemptId !== params.key && !tag.attemptId.startsWith(`${params.key}-`)) continue
    const applied = appliedToInvoiceCents(p, params.invoiceId)
    if (applied > 0) return { paymentId: String(p.Id), appliedCents: applied, method: tag.method }
  }
  return null
}

/**
 * Was a failed QuickBooks WRITE possibly applied anyway? A definite 4xx (validation/permission) means
 * QuickBooks rejected it; anything else — 5xx, 429, network error, timeout/abort — is ambiguous and must
 * be reconciled before another write. Errors thrown before the request (not connected / reauth) are definite.
 */
export function isAmbiguousWriteError(err: unknown): boolean {
  if (err instanceof QBApiError) return err.status >= 500 || err.status === 429 || err.status === 408
  const code = (err as { code?: string } | null)?.code
  if (code === 'qb_not_connected' || code === 'qb_reauth_required') return false
  return true
}

/** Is a lock (recording/sending) old enough to be treated as an interrupted attempt? */
export function lockIsStale(startedAt: Date | string | null | undefined, now: number, staleMs: number): boolean {
  if (!startedAt) return true
  return now - new Date(startedAt).getTime() > staleMs
}

/**
 * Did QuickBooks email the invoice for THIS send? Reads Invoice.DeliveryInfo.DeliveryTime (updated by every
 * send; EmailStatus alone can't tell because an earlier unpaid send already set EmailSent).
 *   - `prior` = the DeliveryTime seen when this send was locked. Confirmation needs a STRICTLY later delivery,
 *     so a recent unpaid-invoice email (or any earlier send) is never mistaken for this one. DeliveryTime has
 *     one-second precision: a delivery in the same second as `prior` is not proof → stays unconfirmed.
 *   - `since` = when this send was locked; the small tolerance covers clock skew between Pitt Stop and
 *     QuickBooks only — it is applied to our own start time, never to an earlier delivery.
 * This confirms QuickBooks ACCEPTED/sent the email — not inbox delivery.
 */
export function deliveredSince(
  invoice: { DeliveryInfo?: { DeliveryType?: string; DeliveryTime?: string } },
  opts: { since: Date | string | null | undefined; prior: Date | string | null | undefined },
  skewMs = 5_000,
): boolean {
  const t = invoice.DeliveryInfo?.DeliveryTime
  if (!t || !opts.since) return false
  const at = new Date(t).getTime()
  if (!Number.isFinite(at)) return false
  if (opts.prior != null) {
    const prior = new Date(opts.prior).getTime()
    if (Number.isFinite(prior) && at <= prior) return false
  }
  return at >= new Date(opts.since).getTime() - skewMs
}
