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

/** Payment states in which the linked invoice must not be rewritten (Sync / fee changes). */
export const PAYMENT_LOCKS_INVOICE: readonly string[] = ['recording', 'paid', 'uncertain', 'review']

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
  Id: string; TotalAmt?: number; PrivateNote?: string; TxnSource?: string
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
