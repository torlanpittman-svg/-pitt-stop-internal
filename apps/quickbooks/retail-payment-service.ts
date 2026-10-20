/**
 * Retail Record Payment + Email Paid Invoice — orchestration (manager/admin, route-enforced).
 *
 * Record Payment applies ONE QuickBooks Payment for the invoice's full open balance, with the chosen
 * method (cash / card terminal / check) and its owner-mapped deposit account. It records money already
 * collected and never charges a card. "Paid" is shown only after QuickBooks reports a zero balance.
 *
 * Duplicate-proof under double-taps, concurrent requests, retries and ambiguous timeouts:
 *   1. reconcile FIRST — read the invoice + its payments; a zero balance (paid online, recorded in
 *      QuickBooks, or by an earlier attempt whose response was lost) is ADOPTED, never paid again;
 *   2. compare-and-set qb_payment_status → 'recording' (one winner; a stale lock is an interrupted attempt);
 *   3. the attempt id is sent as QBO `requestid` and tagged in PrivateNote (PSPAY:…); an UNCERTAIN attempt
 *      is retried with the SAME attempt id, method and amount, so QuickBooks itself returns the original
 *      payment. Until it is resolved (QuickBooks shows it paid, or a definite rejection), a different
 *      method or a fresh attempt is refused — the original may still be landing in QuickBooks;
 *   4. definite failures → 'error' (safe to retry); ambiguous failures → 'uncertain' (reconciled before
 *      any further write);
 *   5. the payment lock and the invoice-changing locks (Sync, charge changes — see invoice-locks.ts) exclude
 *      each other in their compare-and-set statements; the invoice + draft are re-verified UNDER the lock;
 *      and every state write is fenced by (attempt id, lock time), so a stale worker never overwrites a
 *      newer attempt's state.
 *
 * Payment state, invoice create/send state (qb_status) and the paid-invoice email state are separate
 * columns: an email failure never touches the payment. Job status / completedAt are never touched.
 * History is append-only in service_order_events. Dealer jobs are refused (Dealer Check-In owns them).
 */
import crypto from 'node:crypto'
import { and, eq, inArray, isNull, notInArray, or, lt, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { jobEstimates } from '@/apps/workflow/schema'
import { logEvent } from '@/apps/workflow/db'
import { getEstimateRow, projectEstimateTotalCents, recomputeEstimate, type EstimateRow } from '@/apps/workflow/estimate-db'
import { retailPaymentMappingsRaw } from '@/apps/settings/db'
import { logger } from '@/platform/logger'
import { verifyLinkedRetailInvoice, flatPricingIssue, syncRetailQBInvoice, type VerifiedLinkedInvoice } from './retail-invoice-service'
import { getRetailInvoiceRaw, fillRetailInvoiceEmail, sendRetailInvoiceInQB, type RawQBInvoice } from './retail-invoice-write'
import { decideSendRecipient } from './retail-invoice'
import { connectedRealmId, loadInvoicePayments, verifyPaymentMapping, createRetailPaymentInQB } from './retail-payment-write'
import { INVOICE_CHANGING_STATUSES } from './invoice-locks'
import {
  availableMethods, classifyInvoicePayment, isAmbiguousWriteError, isPaymentMethodKey, lockIsStale, linkedPaymentIds,
  parsePaymentMappings, paymentTag, deliveredSince, PAID_METHOD_LABEL, PAYMENT_WRITE_TIMEOUT_MS, RECORDING_STALE_MS, SENDING_STALE_MS,
  type InvoicePaymentState, type MethodAvailability, type PaidMethod, type PaymentMethodKey,
} from './retail-payment'

const APP = 'quickbooks:retail-payment-service'
const safeErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const money = (c: number) => `$${(c / 100).toFixed(2)}`
const newAttemptId = () => crypto.randomUUID()

export type PaymentBlock =
  | 'no_invoice' | 'dealer' | 'not_priced' | 'needs_review' | 'sync_needed' | 'invoice_missing' | 'identity_mismatch'
  | 'customer_mismatch' | 'total_mismatch' | 'invalid_method' | 'not_configured' | 'mapping_invalid' | 'partial_payment'
  | 'invalid_balance' | 'amount_changed' | 'recording' | 'qb_read_failed' | 'record_failed' | 'pricing_unresolved'
  | 'attempt_unresolved' | 'invoice_busy'

export interface PaymentResult {
  ok: boolean
  /** paid = QuickBooks confirmed zero balance. uncertain/review = NOT confirmed (never shown as Paid). */
  status: 'paid' | 'unpaid' | 'recording' | 'uncertain' | 'review' | 'error' | 'refused'
  block?: PaymentBlock
  error?: string
  invoiceId?: string | null
  invoiceNumber?: string | null
  amountCents?: number
  method?: PaidMethod | null
  methodLabel?: string | null
  paymentId?: string | null
  /** Paid before this request (paid online / recorded in QuickBooks / earlier attempt) → adopted, nothing written. */
  reconciled?: boolean
  alreadyPaid?: boolean
}

export interface PaymentPreview extends PaymentResult {
  methods?: MethodAvailability[]
  /** An earlier attempt QuickBooks hasn't confirmed: it can only be checked / retried as this method. */
  pendingMethod?: PaymentMethodKey | null
  /** The invoice still carries a card-payment charge (relevant when the customer pays cash/check). */
  cardChargeCents?: number
  cardChargeLabel?: string
  /** The amount Save will record for each method — Cash / Check with the card charge removed (pricing
   *  engine projection; nothing is changed until Save). */
  methodAmounts?: Record<PaymentMethodKey, number>
  /** How much Cash / Check saves (the un-waived card charge, incl. any effect on tax); 0 = nothing removed. */
  cardFeeRemovalCents?: number
  /** The pinned unconfirmed attempt already removed the card charge (Cash / Check). */
  cardFeeRemoved?: boolean
}

/** An earlier attempt whose outcome QuickBooks hasn't confirmed (ambiguous failure, or an interrupted
 *  worker's stale lock). Its identity — request id, method, amount — is fixed until it is resolved. */
function unresolvedAttempt(est: EstimateRow, now = Date.now()): { attemptId: string; method: PaymentMethodKey; amountCents: number | null } | null {
  const open = est.qbPaymentStatus === 'uncertain' || (est.qbPaymentStatus === 'recording' && lockIsStale(est.qbPaymentStartedAt, now, RECORDING_STALE_MS))
  if (!open || !est.qbPaymentRequestId || !isPaymentMethodKey(est.qbPaymentMethod)) return null
  return { attemptId: est.qbPaymentRequestId, method: est.qbPaymentMethod, amountCents: est.qbPaymentAmountCents ?? null }
}

const BUSY_MSG = 'The QuickBooks invoice is being updated right now. Wait a moment, then open Record Payment again.'

/** Load + validate the owner mappings against the CONNECTED QuickBooks company. */
async function loadMethods(): Promise<{ methods: MethodAvailability[]; cfg: ReturnType<typeof parsePaymentMappings> }> {
  const cfg = parsePaymentMappings(await retailPaymentMappingsRaw())
  return { cfg, methods: availableMethods(cfg, await connectedRealmId()) }
}

/** Read QuickBooks' current payment state for the linked invoice (fresh invoice + its payments). */
async function readPaymentState(est: EstimateRow, raw?: RawQBInvoice | null): Promise<{ raw: RawQBInvoice; state: InvoicePaymentState } | null> {
  const inv = raw ?? await getRetailInvoiceRaw(est.qbInvoiceId!)
  if (!inv) return null
  const payments = await loadInvoicePayments({ linkedIds: linkedPaymentIds(inv), customerId: inv.CustomerRef?.value ?? null, estimateId: est.id })
  return { raw: inv, state: classifyInvoicePayment({ invoice: inv, payments, estimateId: est.id }) }
}

/**
 * Which payment state a "paid" write may replace: the exact state the caller observed before taking its
 * QuickBooks snapshot (status + attempt id + lock time). Anything newer — a takeover, a review flag, another
 * attempt — makes the write a no-op, so an old snapshot can never overwrite newer payment state.
 */
interface PaymentFence { statuses: string[]; requestId: string | null; startedAt: Date | null }
const observedFence = (est: EstimateRow): PaymentFence => ({ statuses: [est.qbPaymentStatus], requestId: est.qbPaymentRequestId ?? null, startedAt: est.qbPaymentStartedAt ?? null })
const fenceWhere = (estId: string, f: PaymentFence) => and(
  eq(jobEstimates.id, estId), inArray(jobEstimates.qbPaymentStatus, f.statuses),
  f.requestId == null ? isNull(jobEstimates.qbPaymentRequestId) : eq(jobEstimates.qbPaymentRequestId, f.requestId),
  f.startedAt == null ? isNull(jobEstimates.qbPaymentStartedAt) : eq(jobEstimates.qbPaymentStartedAt, f.startedAt),
)

/**
 * Persist a QuickBooks-confirmed zero balance (adopted or just recorded) — only over the state the caller
 * observed (see PaymentFence). Returns whether the job is now paid by THIS payment; the audit event is
 * written only for a transition that actually happened (an already-recorded identical payment is a silent no-op).
 */
async function markPaid(est: EstimateRow, s: Extract<InvoicePaymentState, { state: 'paid' }>, actor: string | null, how: 'recorded' | 'reconciled', fence: PaymentFence): Promise<boolean> {
  const fresh = await getEstimateRow(est.serviceOrderId)
  if (fresh?.qbPaymentStatus === 'paid' && fresh.qbPaymentId === s.paymentId) return true
  const done = await getDb().update(jobEstimates).set({
    qbPaymentStatus: 'paid', qbPaymentId: s.paymentId, qbPaymentMethod: s.method, qbPaymentAmountCents: s.amountCents,
    qbPaymentError: null, qbPaidAt: fresh?.qbPaidAt ?? new Date(), qbPaidBy: how === 'recorded' ? actor : (fresh?.qbPaidBy ?? null), updatedAt: new Date(),
  }).where(fenceWhere(est.id, fence)).returning({ id: jobEstimates.id })
  if (done.length === 0) {
    logger.warn(APP, 'paid_write_superseded', { orderId: est.serviceOrderId, paymentId: s.paymentId, how })
    return false
  }
  const label = PAID_METHOD_LABEL[s.method]
  await logEvent({
    serviceOrderId: est.serviceOrderId,
    eventType: how === 'recorded' ? 'invoice_payment_recorded' : 'invoice_payment_reconciled',
    employeeName: actor,
    note: `#${est.qbInvoiceNumber} (${est.qbInvoiceId}) ${how === 'recorded' ? 'paid' : 'already paid in QuickBooks'} · ${label} · ${money(s.amountCents)}${s.paymentId ? ` · QB payment ${s.paymentId}` : ''} · balance $0.00`,
  }).catch(() => {})
  return true
}

/** What the job's payment state is NOW — reported when this request's write was superseded by newer state. */
async function currentPaymentResult(orderId: string): Promise<PaymentResult> {
  const e = await getEstimateRow(orderId)
  const base = { invoiceId: e?.qbInvoiceId ?? null, invoiceNumber: e?.qbInvoiceNumber ?? null }
  if (e?.qbPaymentStatus === 'paid') return { ok: true, status: 'paid', alreadyPaid: true, ...base, amountCents: e.qbPaymentAmountCents ?? undefined, method: e.qbPaymentMethod as PaidMethod, methodLabel: PAID_METHOD_LABEL[e.qbPaymentMethod as PaidMethod] ?? null, paymentId: e.qbPaymentId }
  if (e?.qbPaymentStatus === 'review') return { ok: false, status: 'review', ...base, error: e.qbPaymentError ?? 'This payment needs review in QuickBooks.' }
  if (e?.qbPaymentStatus === 'uncertain') return { ok: false, status: 'uncertain', ...base, error: e.qbPaymentError ?? 'QuickBooks has not confirmed the payment yet. Tap Check again.' }
  if (e?.qbPaymentStatus === 'recording') return { ok: false, status: 'recording', block: 'recording', ...base, error: 'A payment is being recorded for this invoice.' }
  return { ok: false, status: 'refused', block: 'amount_changed', ...base, error: 'The payment state changed while checking. Open Record Payment again.' }
}

function paidResult(est: EstimateRow, s: Extract<InvoicePaymentState, { state: 'paid' }>, extra: Partial<PaymentResult> = {}): PaymentResult {
  return { ok: true, status: 'paid', invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber, amountCents: s.amountCents, method: s.method, methodLabel: PAID_METHOD_LABEL[s.method], paymentId: s.paymentId, ...extra }
}

const BLOCK_MSG: Partial<Record<PaymentBlock, string>> = {
  not_priced: 'Add pricing before recording a payment.',
  needs_review: 'This invoice needs review before a payment can be recorded.',
  sync_needed: 'Sync the QuickBooks invoice before recording a payment.',
  invoice_missing: 'This invoice could not be read from QuickBooks — try again or review it.',
  identity_mismatch: 'This invoice could not be verified in QuickBooks — needs review.',
  customer_mismatch: 'The customer no longer matches this invoice — review before recording a payment.',
  total_mismatch: 'The QuickBooks invoice does not match Pitt Stop’s total. Sync it first.',
  dealer: 'Dealer invoices are handled by Dealer Check-In.',
  no_invoice: 'Create the QuickBooks invoice first.',
}

/**
 * Verify the invoice is current with the authoritative Invoice Draft, then read QuickBooks' payment
 * state. Any QuickBooks-confirmed zero balance is adopted locally right here (no payment written).
 */
async function verifyAndReconcile(orderId: string, actor: string | null, opts: { allowDrift?: boolean } = {}): Promise<
  | { ok: false; result: PaymentResult }
  | { ok: true; v: VerifiedLinkedInvoice; state: Extract<InvoicePaymentState, { state: 'unpaid' }> }
> {
  const est0 = await getEstimateRow(orderId)
  const v = await verifyLinkedRetailInvoice(orderId, opts.allowDrift ? { allowDrift: true } : {})
  if (!v.ok) {
    // A job already confirmed paid stays paid even if the draft has since drifted — report it, don't hide it.
    if (est0?.qbPaymentStatus === 'paid') return { ok: false, result: { ok: true, status: 'paid', alreadyPaid: true, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, amountCents: est0.qbPaymentAmountCents ?? undefined, method: est0.qbPaymentMethod as PaidMethod, methodLabel: est0.qbPaymentMethod ? PAID_METHOD_LABEL[est0.qbPaymentMethod as PaidMethod] ?? null : null, paymentId: est0.qbPaymentId } }
    const block = (v.block ?? 'qb_read_failed') as PaymentBlock
    return { ok: false, result: { ok: false, status: 'refused', block, error: BLOCK_MSG[block] ?? 'This invoice can’t take a payment right now.', invoiceId: v.invoiceId ?? null, invoiceNumber: v.invoiceNumber ?? null } }
  }
  // The Invoice Draft itself must be settled: an unfinished breakdown or an itemized total that still
  // differs from the agreed amount is not an amount to collect, even if QuickBooks matches it.
  if (v.draft.pricingIncomplete || v.draft.referenceCents != null || flatPricingIssue(v.full)) {
    return { ok: false, result: { ok: false, status: 'refused', block: 'pricing_unresolved', invoiceId: v.est.qbInvoiceId, invoiceNumber: v.est.qbInvoiceNumber, error: v.draft.pricingIncomplete ? 'Finish pricing every service before recording a payment.' : 'The itemized total differs from the agreed amount. Resolve it in the Estimate (and sync the invoice) before recording a payment.' } }
  }
  let read
  try { read = await readPaymentState(v.est, v.raw) }
  catch (e) { return { ok: false, result: { ok: false, status: 'refused', block: 'qb_read_failed', error: `Could not check QuickBooks payments: ${safeErr(e)}` } } }
  if (!read) return { ok: false, result: { ok: false, status: 'refused', block: 'invoice_missing', error: BLOCK_MSG.invoice_missing } }
  const s = read.state
  if (s.state === 'paid') {
    // Adopt a zero balance (paid online / in QuickBooks / an earlier lost response) — but only over the state
    // observed before this snapshot was read; a newer review / attempt survives and is reported instead.
    if (!(await markPaid(v.est, s, actor, 'reconciled', observedFence(v.est)))) return { ok: false, result: await currentPaymentResult(orderId) }
    return { ok: false, result: paidResult(v.est, s, { reconciled: v.est.qbPaymentStatus !== 'paid', alreadyPaid: true }) }
  }
  if (s.state === 'partial') return { ok: false, result: { ok: false, status: 'refused', block: 'partial_payment', invoiceId: v.est.qbInvoiceId, invoiceNumber: v.est.qbInvoiceNumber, amountCents: s.balanceCents, error: `QuickBooks already shows ${money(s.paidCents)} paid on this invoice (${money(s.balanceCents)} still open). Partial payments aren’t handled here — finish it in QuickBooks.` } }
  if (s.state === 'invalid') return { ok: false, result: { ok: false, status: 'refused', block: 'invalid_balance', error: s.reason } }
  return { ok: true, v, state: s }
}

/** Methods paid without a card: the card-payment charge is removed from the invoice before paying. */
const REMOVES_CARD_FEE: readonly PaymentMethodKey[] = ['cash', 'check']
/** Written (with the waiver) while the fee-removed invoice is not yet synced — the Invoice Draft shows it. */
const FEE_SYNC_MSG = 'QuickBooks sync needed — card-payment charge removed for a cash/check payment.'

/** Cash / Check total: the authoritative engine's total with the card-payment charge removed (no writes).
 *  Null when there is no un-waived charge to remove (none configured, or already waived — kept as-is). */
async function cashTotalCents(v: VerifiedLinkedInvoice): Promise<number | null> {
  const charge = v.draft.paymentCharge
  if (charge.waived || !(charge.cents > 0)) return null
  return projectEstimateTotalCents(v.est.id, { waiveCardFee: true })
}

/** An unresolved attempt that already removed the card charge locally: QuickBooks may or may not carry the
 *  new total yet. It is resumed (re-sync, then pay with the same attempt id), never redone differently. */
const resumesFeeRemoval = (est: EstimateRow) => !!unresolvedAttempt(est) && est.qbPaymentCardFeeRemoved

/**
 * READ path behind "Record Payment" (runs when the sheet opens, and as "Check again"): verifies the
 * invoice, reconciles any payment already in QuickBooks, and returns the open balance, the amount per
 * method (Cash / Check: card charge removed, computed by the pricing engine) and the methods that may be
 * recorded. Writes only local reconciliation state — never a QuickBooks write, never a charge change.
 */
export async function previewRetailPayment(params: { orderId: string; actor: string | null }): Promise<PaymentPreview> {
  const { orderId, actor } = params
  const est = await getEstimateRow(orderId)
  if (!est?.qbInvoiceId) return { ok: false, status: 'refused', block: 'no_invoice', error: BLOCK_MSG.no_invoice }
  const r = await verifyAndReconcile(orderId, actor, { allowDrift: resumesFeeRemoval(est) })
  if (!r.ok) return r.result
  const { methods } = await loadMethods()
  // An earlier attempt that was not confirmed, and QuickBooks still shows the full balance open.
  const fresh = await getEstimateRow(orderId)
  const pending = fresh?.qbPaymentStatus === 'recording' && !lockIsStale(fresh.qbPaymentStartedAt, Date.now(), RECORDING_STALE_MS)
  const unresolved = fresh ? unresolvedAttempt(fresh) : null
  const status: PaymentResult['status'] = pending ? 'recording' : unresolved ? 'uncertain' : fresh?.qbPaymentStatus === 'review' ? 'review' : 'unpaid'
  const charge = r.v.draft.paymentCharge
  const balance = r.state.balanceCents
  let methodAmounts: Record<PaymentMethodKey, number>
  let cardFeeRemovalCents = 0
  if (fresh && resumesFeeRemoval(fresh)) {
    // Resuming: the charge is already removed; the pinned attempt's amount is the only amount.
    const pinned = unresolved?.amountCents ?? r.v.draft.totalCents
    methodAmounts = { cash: pinned, check: pinned, card_terminal: pinned }
  } else {
    const cash = await cashTotalCents(r.v)
    if (cash != null) cardFeeRemovalCents = balance - cash
    methodAmounts = { cash: cash ?? balance, check: cash ?? balance, card_terminal: balance }
  }
  return {
    ok: true, status, invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber, amountCents: balance, methods,
    pendingMethod: unresolved?.method ?? null,
    error: fresh?.qbPaymentError ?? undefined,
    cardChargeCents: !charge.waived && charge.cents > 0 ? charge.cents : 0, cardChargeLabel: charge.label,
    methodAmounts, cardFeeRemovalCents, cardFeeRemoved: !!fresh?.qbPaymentCardFeeRemoved && !!unresolved,
  }
}

/**
 * Record the counter payment. `confirmedAmountCents` is the amount the manager saw and confirmed for the
 * chosen method; if it differs now, nothing is written and the new amount is returned for re-confirmation.
 *
 * Cash / Check with an un-waived card-payment charge: under the payment lock, (a) re-check QuickBooks
 * (already paid → adopted, charges untouched), (b) remove the charge through the pricing engine, (c) sync
 * the SAME invoice, (d) verify QuickBooks now equals the confirmed total, then (e) pay that balance with the
 * attempt id. If the invoice update definitely did not happen, the charge is restored and nothing is
 * recorded; if it may have happened, the attempt stays pinned (method + amount + id) and a retry re-syncs
 * (a no-op if it landed) before paying — never a payment against an unverified amount.
 */
export async function recordRetailPayment(params: { orderId: string; actor: string | null; method: unknown; confirmedAmountCents: unknown }): Promise<PaymentResult> {
  const { orderId, actor } = params
  const db = getDb()
  if (!isPaymentMethodKey(params.method)) return { ok: false, status: 'refused', block: 'invalid_method', error: 'Choose Cash, Card Terminal or Check.' }
  const method: PaymentMethodKey = params.method
  const confirmed = typeof params.confirmedAmountCents === 'number' && Number.isInteger(params.confirmedAmountCents) ? params.confirmedAmountCents : NaN

  const est0 = await getEstimateRow(orderId)
  if (!est0?.qbInvoiceId) return { ok: false, status: 'refused', block: 'no_invoice', error: BLOCK_MSG.no_invoice }
  if (est0.qbPaymentStatus === 'recording' && !lockIsStale(est0.qbPaymentStartedAt, Date.now(), RECORDING_STALE_MS)) {
    return { ok: false, status: 'recording', block: 'recording', error: 'A payment is already being recorded for this invoice.' }
  }
  if (INVOICE_CHANGING_STATUSES.includes(est0.qbStatus)) return { ok: false, status: 'refused', block: 'invoice_busy', error: BUSY_MSG }

  // (1) Verify current + reconcile BEFORE anything is written. A pinned attempt that already removed the
  // card charge is checked for identity only here — its invoice is re-synced and verified under the lock.
  const drift = resumesFeeRemoval(est0)
  const r = await verifyAndReconcile(orderId, actor, { allowDrift: drift })
  if (!r.ok) return r.result
  const { v, state } = r
  let target: number           // the amount to record = the invoice total once any adjustment is synced
  let removeFee = false
  if (drift) {
    target = v.common.draftTotalCents
  } else {
    if (state.balanceCents !== v.common.draftTotalCents) {
      return { ok: false, status: 'refused', block: 'total_mismatch', error: BLOCK_MSG.total_mismatch }
    }
    const cash = REMOVES_CARD_FEE.includes(method) ? await cashTotalCents(v) : null
    removeFee = cash != null
    target = cash ?? state.balanceCents
  }
  // An unconfirmed earlier attempt (QuickBooks still shows the balance open — it may yet appear): only that
  // attempt may be retried, as the same method and amount. Never a second, different payment — and choosing
  // another method can't route around it (the card charge is not re-added or removed for a different method).
  const pendingAttempt = unresolvedAttempt((await getEstimateRow(orderId))!)
  if (pendingAttempt && (pendingAttempt.method !== method || (pendingAttempt.amountCents != null && pendingAttempt.amountCents !== target))) {
    const label = PAID_METHOD_LABEL[pendingAttempt.method]
    return {
      ok: false, status: 'uncertain', block: 'attempt_unresolved', method: pendingAttempt.method, methodLabel: label,
      amountCents: pendingAttempt.amountCents ?? target, invoiceId: v.est.qbInvoiceId, invoiceNumber: v.est.qbInvoiceNumber,
      error: pendingAttempt.method !== method
        ? `An earlier ${label} payment of ${money(pendingAttempt.amountCents ?? target)} was not confirmed by QuickBooks yet. Check again, or retry it as ${label} — a different method can’t be recorded until it is resolved.`
        : `An earlier ${label} payment of ${money(pendingAttempt.amountCents!)} was not confirmed, and the amount due is now ${money(target)}. Review the invoice in QuickBooks.`,
    }
  }

  if (confirmed !== target) {
    return { ok: false, status: 'refused', block: 'amount_changed', amountCents: target, invoiceId: v.est.qbInvoiceId, invoiceNumber: v.est.qbInvoiceNumber, error: `The amount due${removeFee ? ` (${PAID_METHOD_LABEL[method]}, card charge removed)` : ''} is now ${money(target)}. Confirm the new amount.` }
  }

  const { cfg, methods } = await loadMethods()
  const avail = methods.find((m) => m.key === method)
  const mapping = cfg.methods[method]
  if (!avail?.available || !mapping) {
    return { ok: false, status: 'refused', block: 'not_configured', error: avail?.reason === 'realm_mismatch' ? 'Payment setup belongs to a different QuickBooks company. An admin must confirm the payment mappings.' : `${PAID_METHOD_LABEL[method]} isn’t set up for QuickBooks yet. An admin must map it first.` }
  }
  const mappingErr = await verifyPaymentMapping(mapping).catch((e) => `Could not verify the payment setup in QuickBooks: ${safeErr(e)}`)
  if (mappingErr) return { ok: false, status: 'refused', block: 'mapping_invalid', error: mappingErr }

  // (2) Lock. An unconfirmed (uncertain / stale) attempt is retried with the SAME attempt id so QuickBooks'
  // requestid de-duplication returns the original payment if it was in fact created. The compare-and-set
  // pins that identity (request id + method) and requires no invoice-changing operation in progress
  // (Sync / create — whose own locks require no payment in progress: see invoice-locks.ts).
  const est1 = (await getEstimateRow(orderId))!
  const resume = unresolvedAttempt(est1)
  const resumeAttempt = !!resume
  if (resume && !!est1.qbPaymentCardFeeRemoved !== drift) {
    return { ok: false, status: 'refused', block: 'amount_changed', error: 'The payment state changed while checking. Open Record Payment again.' }
  }
  const attemptId = resume ? resume.attemptId : newAttemptId()
  const lockAt = new Date()
  const staleBefore = new Date(lockAt.getTime() - RECORDING_STALE_MS)
  const idle = notInArray(jobEstimates.qbStatus, INVOICE_CHANGING_STATUSES)
  const from = resume
    ? and(eq(jobEstimates.qbPaymentRequestId, resume.attemptId), eq(jobEstimates.qbPaymentMethod, method), or(
        eq(jobEstimates.qbPaymentStatus, 'uncertain'),
        and(eq(jobEstimates.qbPaymentStatus, 'recording'), or(lt(jobEstimates.qbPaymentStartedAt, staleBefore), sql`${jobEstimates.qbPaymentStartedAt} IS NULL`)),
      ))
    : inArray(jobEstimates.qbPaymentStatus, ['none', 'error'])
  const locked = await db.update(jobEstimates)
    .set({ qbPaymentStatus: 'recording', qbPaymentRequestId: attemptId, qbPaymentMethod: method, qbPaymentAmountCents: target, qbPaymentStartedAt: lockAt, qbPaymentError: null, ...(resume ? {} : { qbPaymentCardFeeRemoved: false }), updatedAt: new Date() })
    .where(and(eq(jobEstimates.id, est1.id), idle, from))
    .returning({ id: jobEstimates.id })
  if (locked.length === 0) {
    const fresh = await getEstimateRow(orderId)
    if (fresh && INVOICE_CHANGING_STATUSES.includes(fresh.qbStatus)) return { ok: false, status: 'refused', block: 'invoice_busy', error: BUSY_MSG }
    if (fresh?.qbPaymentStatus === 'paid') return { ok: true, status: 'paid', alreadyPaid: true, invoiceId: fresh.qbInvoiceId, invoiceNumber: fresh.qbInvoiceNumber, amountCents: fresh.qbPaymentAmountCents ?? undefined, method: fresh.qbPaymentMethod as PaidMethod, methodLabel: PAID_METHOD_LABEL[fresh.qbPaymentMethod as PaidMethod] ?? null, paymentId: fresh.qbPaymentId }
    if (fresh?.qbPaymentStatus === 'review') return { ok: false, status: 'review', error: fresh.qbPaymentError ?? 'This payment needs review in QuickBooks.' }
    return { ok: false, status: 'recording', block: 'recording', error: 'A payment is already being recorded for this invoice.' }
  }
  await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_attempt', employeeName: actor, note: `#${v.est.qbInvoiceNumber} (${v.est.qbInvoiceId}) ${PAID_METHOD_LABEL[method]} ${money(target)} · attempt ${attemptId}${removeFee ? ` · card charge removed (was ${money(state.balanceCents)})` : ''}${resumeAttempt ? ' · resumed after unconfirmed attempt' : ''}` }).catch(() => {})

  // Fenced: only THIS worker's lock (same attempt, same lock time, still recording) may move the state. A
  // worker that stalled past the stale window and was taken over writes nothing.
  const lockFence: PaymentFence = { statuses: ['recording'], requestId: attemptId, startedAt: lockAt }
  const setState = async (patch: Partial<typeof jobEstimates.$inferInsert>, fence: PaymentFence = lockFence): Promise<boolean> =>
    (await db.update(jobEstimates).set({ ...patch, updatedAt: new Date() }).where(fenceWhere(est1.id, fence)).returning({ id: jobEstimates.id })).length > 0
  const release = () => setState({ qbPaymentStatus: resumeAttempt ? 'uncertain' : 'none' })

  // The card charge THIS worker removed while QuickBooks still has the original invoice: put it back (same
  // engine) together with the lock release, so a definite failure leaves no trace but the audit history.
  let feeApplied = false
  const releaseRestoringFee = async (patch: Partial<typeof jobEstimates.$inferInsert> = { qbPaymentStatus: resumeAttempt ? 'uncertain' : 'none' }): Promise<boolean> => {
    if (!feeApplied) return setState(patch)
    if (!(await setState({ ...patch, waiveCardFee: false, qbPaymentCardFeeRemoved: false }))) return false
    feeApplied = false
    await recomputeEstimate(est1.id)
    await db.update(jobEstimates).set({ qbSyncError: est1.qbSyncError ?? null, updatedAt: new Date() })
      .where(and(eq(jobEstimates.id, est1.id), eq(jobEstimates.qbSyncError, FEE_SYNC_MSG)))
    await logEvent({ serviceOrderId: orderId, eventType: 'invoice_override', employeeName: actor, note: JSON.stringify({ field: 'Payment charge', key: 'payment', action: 'restored', old: true, new: false, via: 'record_payment', method, attempt: attemptId, reason: 'QuickBooks invoice was not updated — nothing recorded' }) }).catch(() => {})
    return true
  }

  // (3) Re-verify UNDER the lock: a Sync or charge change that committed after the checks above but before
  // the lock (both now excluded) must not leave us collecting a stale amount.
  const v2 = await verifyLinkedRetailInvoice(orderId, drift ? { allowDrift: true } : {})
  const v2Stale = !v2.ok || v2.draft.pricingIncomplete || v2.draft.referenceCents != null || flatPricingIssue(v2.full)
    || (drift
      ? v2.common.draftTotalCents !== target
      : v2.common.draftTotalCents !== state.balanceCents || v2.common.qbTotalCents !== v.common.qbTotalCents
        || (removeFee && (await cashTotalCents(v2)) !== target))
  if (v2Stale) {
    await release()
    const block = (!v2.ok ? (v2.block ?? 'qb_read_failed') : 'amount_changed') as PaymentBlock
    return { ok: false, status: 'refused', block, invoiceId: v.est.qbInvoiceId, invoiceNumber: v.est.qbInvoiceNumber, error: !v2.ok ? (BLOCK_MSG[block] ?? 'This invoice can’t take a payment right now.') : 'The invoice changed while saving. Nothing was recorded — open Record Payment again.' }
  }

  // (4) Re-reconcile under the lock (a concurrent online payment / an earlier lost response) — BEFORE any
  // charge change: an invoice that is already paid is adopted as-is, its charges untouched.
  let under
  try { under = await readPaymentState(v.est) }
  catch (e) {
    if (!(await setState({ qbPaymentStatus: resumeAttempt ? 'uncertain' : 'error', qbPaymentError: `Could not check QuickBooks before saving: ${safeErr(e)}` }))) return currentPaymentResult(orderId)
    return { ok: false, status: resumeAttempt ? 'uncertain' : 'error', block: 'qb_read_failed', error: 'Could not check QuickBooks before saving. Nothing was recorded — try again.' }
  }
  const adoptOrRefuse = async (u: typeof under, expected: number | null): Promise<PaymentResult | null> => {
    if (u && u.state.state === 'unpaid' && (expected == null || u.state.balanceCents === expected)) return null
    if (u?.state.state === 'paid') {
      if (!(await markPaid(v.est, u.state, actor, u.state.attemptId === attemptId ? 'recorded' : 'reconciled', lockFence))) return currentPaymentResult(orderId)
      return paidResult(v.est, u.state, { reconciled: u.state.attemptId !== attemptId, alreadyPaid: u.state.attemptId !== attemptId })
    }
    if (!(await releaseRestoringFee())) return currentPaymentResult(orderId)
    return { ok: false, status: 'refused', block: 'amount_changed', error: 'QuickBooks changed while saving. Nothing was recorded — open Record Payment again.' }
  }
  const early = await adoptOrRefuse(under, drift ? null : state.balanceCents)
  if (early) return early
  let payRaw = under!.raw

  // (5) Cash / Check: remove the card charge (pricing engine), sync the SAME invoice, verify QuickBooks.
  if (removeFee || drift) {
    if (removeFee) {
      const applied = await db.update(jobEstimates)
        .set({ waiveCardFee: true, qbPaymentCardFeeRemoved: true, qbSyncError: FEE_SYNC_MSG, updatedAt: new Date() })
        .where(and(fenceWhere(est1.id, lockFence), eq(jobEstimates.waiveCardFee, false)))
        .returning({ id: jobEstimates.id })
      if (applied.length === 0) {
        if (!(await release())) return currentPaymentResult(orderId)
        return { ok: false, status: 'refused', block: 'amount_changed', error: 'The invoice changed while saving. Nothing was recorded — open Record Payment again.' }
      }
      feeApplied = true
      await recomputeEstimate(est1.id)
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_override', employeeName: actor, note: JSON.stringify({ field: 'Payment charge', key: 'payment', action: 'removed', old: false, new: true, via: 'record_payment', method, attempt: attemptId, reason: `Paid by ${PAID_METHOD_LABEL[method]} — card-payment charge removed` }) }).catch(() => {})
      const adjusted = await getEstimateRow(orderId)
      if (adjusted?.totalCents !== target) {
        if (!(await releaseRestoringFee())) return currentPaymentResult(orderId)
        return { ok: false, status: 'refused', block: 'amount_changed', error: 'The invoice changed while saving. Nothing was recorded — open Record Payment again.' }
      }
    }

    const tokenBefore = String(payRaw.SyncToken ?? '')
    const synced = await syncRetailQBInvoice({ orderId, actor, confirmSent: true, paymentLock: { requestId: attemptId, startedAt: lockAt } })
    if (!synced.ok) {
      // Only a DEFINITE failure that left the QuickBooks invoice exactly as it was may be undone; anything
      // else keeps this attempt pinned (same method, amount, id) — a retry re-syncs before it pays.
      const now = synced.ambiguous ? null : await getRetailInvoiceRaw(est1.qbInvoiceId!).catch(() => null)
      const unchanged = !!now && String(now.SyncToken ?? '') === tokenBefore
      const why = synced.error ?? synced.reviewReason ?? synced.block ?? 'unknown error'
      if (unchanged && feeApplied) {
        if (!(await releaseRestoringFee({ qbPaymentStatus: resumeAttempt ? 'uncertain' : 'error', qbPaymentError: `QuickBooks invoice update failed: ${why}` }))) return currentPaymentResult(orderId)
        await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_failed', employeeName: actor, note: `${PAID_METHOD_LABEL[method]} ${money(target)} · invoice update failed, card charge restored: ${why}` }).catch(() => {})
        return { ok: false, status: 'error', block: 'record_failed', error: `QuickBooks did not update the invoice (${why}). Nothing was recorded and the card charge was put back.` }
      }
      const msg = `The QuickBooks invoice update for this ${PAID_METHOD_LABEL[method]} payment was not confirmed (${why}). Nothing was paid. Tap Save as ${PAID_METHOD_LABEL[method]} again — it re-checks the invoice first and won’t record a second payment.`
      if (!(await setState({ qbPaymentStatus: 'uncertain', qbPaymentError: msg }))) return currentPaymentResult(orderId)
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_uncertain', employeeName: actor, note: `${PAID_METHOD_LABEL[method]} ${money(target)} · attempt ${attemptId}: invoice update unconfirmed — ${why}` }).catch(() => {})
      return { ok: false, status: 'uncertain', method, methodLabel: PAID_METHOD_LABEL[method], amountCents: target, error: msg }
    }
    feeApplied = false   // QuickBooks now carries the adjusted invoice: the removal is no longer undone here

    const v3 = await verifyLinkedRetailInvoice(orderId)
    if (!v3.ok || v3.draft.pricingIncomplete || v3.draft.referenceCents != null || flatPricingIssue(v3.full)
        || v3.common.draftTotalCents !== target || v3.common.qbTotalCents !== target) {
      const msg = `The QuickBooks invoice no longer matches the confirmed ${money(target)} after the card charge was removed. Nothing was paid — review the invoice, then open Record Payment again.`
      if (!(await setState({ qbPaymentStatus: resumeAttempt ? 'uncertain' : 'error', qbPaymentError: msg }))) return currentPaymentResult(orderId)
      return { ok: false, status: resumeAttempt ? 'uncertain' : 'error', block: 'amount_changed', error: msg }
    }
    let afterSync
    try { afterSync = await readPaymentState(v3.est, v3.raw) }
    catch (e) {
      if (!(await setState({ qbPaymentStatus: 'uncertain', qbPaymentError: `Invoice updated, but QuickBooks payments could not be checked: ${safeErr(e)}` }))) return currentPaymentResult(orderId)
      return { ok: false, status: 'uncertain', block: 'qb_read_failed', error: 'The invoice was updated, but QuickBooks could not be checked before paying. Nothing was paid — tap Save again.' }
    }
    const late = await adoptOrRefuse(afterSync, target)
    if (late) return late
    payRaw = afterSync!.raw
  }

  // (6) Write the QuickBooks Payment.
  try {
    const created = await createRetailPaymentInQB({
      customerId: String(payRaw.CustomerRef?.value ?? ''), invoiceId: String(payRaw.Id), amountCents: target,
      paymentMethodId: mapping.paymentMethodId, depositAccountId: mapping.depositAccountId,
      privateNote: `${paymentTag(v.est.id, attemptId, method)} · Pitt Stop counter payment (${PAID_METHOD_LABEL[method]}) by ${actor ?? 'unknown'}`,
      requestId: attemptId,
    })
    await setState({ qbPaymentId: created.paymentId })
    // (7) Confirm in QuickBooks: Paid only on a zero balance.
    let after
    try { after = await readPaymentState(v.est) } catch { after = null }
    if (after?.state.state === 'paid') {
      // Fenced on THIS worker's lock: an old worker resuming with a paid confirmation never overwrites newer state.
      if (!(await markPaid(v.est, { ...after.state, method, paymentId: created.paymentId, amountCents: created.totalCents }, actor, 'recorded', lockFence))) return currentPaymentResult(orderId)
      logger.info(APP, 'payment_recorded', { orderId, paymentId: created.paymentId, method, amount: created.totalCents })
      return paidResult(v.est, { ...after.state, method, paymentId: created.paymentId, amountCents: created.totalCents })
    }
    if (!after) {
      if (!(await setState({ qbPaymentStatus: 'uncertain', qbPaymentError: `QuickBooks payment ${created.paymentId} was created, but the zero balance could not be confirmed yet.` }))) return currentPaymentResult(orderId)
      return { ok: false, status: 'uncertain', paymentId: created.paymentId, error: 'Payment saved in QuickBooks, but the paid balance could not be confirmed yet. Tap Check again.' }
    }
    const bal = after.state.state === 'unpaid' || after.state.state === 'partial' ? after.state.balanceCents : null
    const msg = `QuickBooks payment ${created.paymentId} was recorded, but the invoice still shows ${bal != null ? money(bal) : 'an unexpected balance'} due — review in QuickBooks.`
    if (!(await setState({ qbPaymentStatus: 'review', qbPaymentError: msg }))) return currentPaymentResult(orderId)
    await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_review', employeeName: actor, note: msg }).catch(() => {})
    return { ok: false, status: 'review', paymentId: created.paymentId, error: msg }
  } catch (err) {
    const msg = safeErr(err)
    if (!isAmbiguousWriteError(err)) {
      // QuickBooks definitely rejected it — nothing was recorded; a retry starts a new attempt.
      if (!(await setState({ qbPaymentStatus: 'error', qbPaymentError: msg }))) return currentPaymentResult(orderId)
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_failed', employeeName: actor, note: `${PAID_METHOD_LABEL[method]} ${money(target)}: ${msg}` }).catch(() => {})
      logger.error(APP, 'payment_failed', { orderId, error: msg })
      return { ok: false, status: 'error', block: 'record_failed', error: `QuickBooks did not record the payment: ${msg}` }
    }
    // Ambiguous (timeout / network / 5xx) — maybe recorded. Reconcile now; never write again blind.
    if (!(await setState({ qbPaymentStatus: 'uncertain', qbPaymentError: `Unconfirmed: ${msg}` }))) return currentPaymentResult(orderId)
    await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_uncertain', employeeName: actor, note: `${PAID_METHOD_LABEL[method]} ${money(target)} · attempt ${attemptId}: ${msg}` }).catch(() => {})
    logger.warn(APP, 'payment_uncertain', { orderId, attemptId, error: msg })
    const check = await readPaymentState(v.est).catch(() => null)
    if (check?.state.state === 'paid') {
      const uncertainFence: PaymentFence = { statuses: ['uncertain'], requestId: attemptId, startedAt: lockAt }
      if (!(await markPaid(v.est, check.state, actor, check.state.attemptId === attemptId ? 'recorded' : 'reconciled', uncertainFence))) return currentPaymentResult(orderId)
      return paidResult(v.est, check.state)
    }
    return { ok: false, status: 'uncertain', method, methodLabel: PAID_METHOD_LABEL[method], error: `QuickBooks did not confirm the ${PAID_METHOD_LABEL[method]} payment. Nothing is shown as paid. Tap Check again — retrying as ${PAID_METHOD_LABEL[method]} is safe and will not record a second payment.` }
  }
}

// ── Email Paid Invoice ────────────────────────────────────────────────────────
export interface PaidEmailResult {
  ok: boolean
  status: 'sent' | 'sending' | 'uncertain' | 'error' | 'refused'
  block?: 'not_paid' | 'no_invoice' | 'dealer' | 'identity_mismatch' | 'customer_mismatch' | 'invoice_missing' | 'email_required' | 'email_conflict' | 'sending' | 'send_failed' | 'qb_read_failed' | 'unconfirmed' | 'invoice_busy'
  error?: string
  recipient?: string | null
  invoiceNumber?: string | null
  alreadySent?: boolean
  sentAt?: string | null
  /** An earlier send QuickBooks hasn't confirmed: only "Check again" or an explicit "Send another copy". */
  unconfirmed?: boolean
}

async function resolvePaidEmail(orderId: string): Promise<{ ok: false; result: PaidEmailResult } | { ok: true; v: VerifiedLinkedInvoice; recipient: string; needsFill: boolean }> {
  const est = await getEstimateRow(orderId)
  if (!est?.qbInvoiceId) return { ok: false, result: { ok: false, status: 'refused', block: 'no_invoice', error: 'No QuickBooks invoice is linked.' } }
  if (est.qbPaymentStatus !== 'paid') return { ok: false, result: { ok: false, status: 'refused', block: 'not_paid', error: 'Record the payment first — this invoice is not confirmed paid.' } }
  const v = await verifyLinkedRetailInvoice(orderId, { paidInvoice: true })
  if (!v.ok) return { ok: false, result: { ok: false, status: 'refused', block: (v.block === 'dealer' || v.block === 'identity_mismatch' || v.block === 'customer_mismatch' || v.block === 'invoice_missing' || v.block === 'no_invoice') ? v.block : 'qb_read_failed', error: 'This invoice could not be verified in QuickBooks — review it before emailing.' } }
  // Confirm PAID in QuickBooks right now — never email a "paid" invoice QuickBooks says is open.
  const balance = Math.round((v.raw.Balance ?? NaN) * 100)
  if (balance !== 0) {
    const msg = `QuickBooks now shows ${Number.isFinite(balance) ? money(balance) : 'an open balance'} due on this invoice — review the payment in QuickBooks.`
    // Only over the paid state this check observed (same payment) — never over a newer payment state.
    const flagged = await getDb().update(jobEstimates).set({ qbPaymentStatus: 'review', qbPaymentError: msg, updatedAt: new Date() })
      .where(and(eq(jobEstimates.id, est.id), eq(jobEstimates.qbPaymentStatus, 'paid'), est.qbPaymentId == null ? isNull(jobEstimates.qbPaymentId) : eq(jobEstimates.qbPaymentId, est.qbPaymentId)))
      .returning({ id: jobEstimates.id })
    if (flagged.length) await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_review', note: msg }).catch(() => {})
    return { ok: false, result: { ok: false, status: 'refused', block: 'not_paid', error: msg } }
  }
  const d = decideSendRecipient(v.raw.BillEmail?.Address ?? null, v.contact.email)
  if (!d.ok) return { ok: false, result: { ok: false, status: 'refused', block: d.block, recipient: d.recipient ?? null, error: d.block === 'email_required' ? 'A customer email address is required.' : 'The Pitt Stop email and the QuickBooks invoice email differ — review before emailing.' } }
  return { ok: true, v, recipient: d.recipient!, needsFill: !!d.needsFill }
}

/** READ-ONLY preview for the Email Paid Invoice confirmation (recipient + paid confirmation). */
export async function previewPaidInvoiceEmail(orderId: string): Promise<PaidEmailResult> {
  const r = await resolvePaidEmail(orderId)
  if (!r.ok) return r.result
  const est = r.v.est
  const unconfirmed = est.qbPaidEmailStatus === 'uncertain' || (est.qbPaidEmailStatus === 'sending' && lockIsStale(est.qbPaidEmailStartedAt, Date.now(), SENDING_STALE_MS))
  return { ok: true, status: est.qbPaidEmailStatus === 'sent' ? 'sent' : unconfirmed ? 'uncertain' : 'refused', recipient: r.recipient, invoiceNumber: est.qbInvoiceNumber, alreadySent: est.qbPaidEmailStatus === 'sent', unconfirmed, sentAt: est.qbPaidEmailSentAt ? new Date(est.qbPaidEmailSentAt).toISOString() : null }
}

/**
 * Email the SAME QuickBooks invoice (now paid) via QuickBooks' invoice send. Explicit user action only.
 * Never creates a Sales Receipt / invoice / sale. Separate from the unpaid Send (qb_status), so it works
 * even when the unpaid invoice was emailed before. Failure leaves the payment exactly as it was.
 *
 * Duplicate-proof: an earlier send whose outcome is unknown (ambiguous response, or an interrupted worker) is
 * only ever CHECKED by a normal call — QuickBooks' DeliveryInfo must show a delivery strictly after the one
 * seen when that send was locked. Not seeing it yet does not prove the send failed, so nothing is sent again
 * unless the person explicitly asks for another copy (`resend`). `checkOnly` never sends. Every state write
 * is fenced on the attempt's lock time, so a stale worker never overwrites a newer attempt.
 * "Sent" means QuickBooks accepted/sent the email — not that it reached the inbox.
 */
export async function sendPaidRetailInvoice(params: { orderId: string; actor: string | null; resend?: boolean; checkOnly?: boolean }): Promise<PaidEmailResult> {
  const { orderId, actor } = params
  const resend = !!params.resend && !params.checkOnly
  const db = getDb()
  const r = await resolvePaidEmail(orderId)
  if (!r.ok) return r.result
  const { v, recipient } = r
  const est = v.est
  const base = { recipient, invoiceNumber: est.qbInvoiceNumber }
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null)

  // (1) An earlier send whose outcome is unknown: check QuickBooks first.
  const staleSending = est.qbPaidEmailStatus === 'sending' && lockIsStale(est.qbPaidEmailStartedAt, Date.now(), SENDING_STALE_MS)
  if (est.qbPaidEmailStatus === 'uncertain' || staleSending) {
    if (deliveredSince(v.raw, { since: est.qbPaidEmailStartedAt, prior: est.qbPaidEmailPriorDeliveryAt })) {
      const sentAt = new Date(v.raw.DeliveryInfo!.DeliveryTime!)
      const done = await db.update(jobEstimates).set({ qbPaidEmailStatus: 'sent', qbPaidEmailSentAt: sentAt, qbPaidEmailError: null, updatedAt: new Date() })
        .where(and(eq(jobEstimates.id, est.id), eq(jobEstimates.qbPaidEmailStatus, est.qbPaidEmailStatus),
          est.qbPaidEmailStartedAt ? eq(jobEstimates.qbPaidEmailStartedAt, est.qbPaidEmailStartedAt) : isNull(jobEstimates.qbPaidEmailStartedAt)))
        .returning({ id: jobEstimates.id })
      if (done.length) await logEvent({ serviceOrderId: orderId, eventType: 'invoice_paid_email_reconciled', employeeName: actor, note: `#${est.qbInvoiceNumber} paid invoice email confirmed by QuickBooks DeliveryInfo at ${sentAt.toISOString()} (no re-send)` }).catch(() => {})
      return { ok: true, status: 'sent', alreadySent: true, sentAt: sentAt.toISOString(), ...base }
    }
    if (!resend) {
      return { ok: false, status: 'uncertain', block: 'unconfirmed', unconfirmed: true, ...base,
        error: `QuickBooks hasn’t confirmed the earlier paid-invoice email to ${recipient}. It may still have been sent, so it was not sent again. Check again in a minute, or choose “Send another copy”. The payment is still recorded.` }
    }
  }
  if (params.checkOnly) {
    return est.qbPaidEmailStatus === 'sent'
      ? { ok: true, status: 'sent', alreadySent: true, sentAt: iso(est.qbPaidEmailSentAt), ...base }
      : { ok: false, status: est.qbPaidEmailStatus === 'sending' ? 'sending' : 'refused', block: est.qbPaidEmailStatus === 'sending' ? 'sending' : 'not_paid', ...base, error: 'Nothing to check — the paid invoice has not been emailed from Pitt Stop yet.' }
  }
  if (est.qbPaidEmailStatus === 'sent' && !resend) {
    return { ok: true, status: 'sent', alreadySent: true, sentAt: iso(est.qbPaidEmailSentAt), ...base }
  }

  // (2) Lock. A normal send only from a settled not-sent state (none / definite error); everything else needs
  // an explicit resend. Never while an unpaid-invoice send is in flight (its DeliveryInfo would be ambiguous).
  const staleBefore = new Date(Date.now() - SENDING_STALE_MS)
  const allowed = resend ? ['none', 'error', 'uncertain', 'sent'] : ['none', 'error']
  const lockAt = new Date()
  const priorDelivery = v.raw.DeliveryInfo?.DeliveryTime ? new Date(v.raw.DeliveryInfo.DeliveryTime) : null
  const locked = await db.update(jobEstimates)
    .set({ qbPaidEmailStatus: 'sending', qbPaidEmailTo: recipient, qbPaidEmailStartedAt: lockAt, qbPaidEmailPriorDeliveryAt: priorDelivery, qbPaidEmailError: null, updatedAt: new Date() })
    .where(and(eq(jobEstimates.id, est.id), eq(jobEstimates.qbPaymentStatus, 'paid'), notInArray(jobEstimates.qbStatus, ['sending']), or(
      inArray(jobEstimates.qbPaidEmailStatus, allowed),
      resend ? and(eq(jobEstimates.qbPaidEmailStatus, 'sending'), or(lt(jobEstimates.qbPaidEmailStartedAt, staleBefore), sql`${jobEstimates.qbPaidEmailStartedAt} IS NULL`)) : sql`false`,
    )))
    .returning({ id: jobEstimates.id })
  if (locked.length === 0) {
    const fresh = await getEstimateRow(orderId)
    if (fresh?.qbStatus === 'sending') return { ok: false, status: 'refused', block: 'invoice_busy', error: 'The invoice is being emailed right now. Try again in a moment.', ...base }
    if (fresh?.qbPaidEmailStatus === 'sent' && !resend) return { ok: true, status: 'sent', alreadySent: true, sentAt: iso(fresh.qbPaidEmailSentAt), ...base }
    if (fresh?.qbPaidEmailStatus === 'uncertain') return { ok: false, status: 'uncertain', block: 'unconfirmed', unconfirmed: true, ...base, error: 'QuickBooks hasn’t confirmed the earlier paid-invoice email. Check again, or choose “Send another copy”.' }
    return { ok: false, status: 'sending', block: 'sending', error: 'The paid invoice is already being emailed.', ...base }
  }

  // Fenced on THIS attempt (status 'sending' + its lock time).
  const setState = async (patch: Partial<typeof jobEstimates.$inferInsert>): Promise<boolean> =>
    (await db.update(jobEstimates).set({ ...patch, updatedAt: new Date() })
      .where(and(eq(jobEstimates.id, est.id), eq(jobEstimates.qbPaidEmailStatus, 'sending'), eq(jobEstimates.qbPaidEmailStartedAt, lockAt)))
      .returning({ id: jobEstimates.id })).length > 0
  const superseded = async (): Promise<PaidEmailResult> => {
    const e = await getEstimateRow(orderId)
    const st = e?.qbPaidEmailStatus
    return st === 'sent'
      ? { ok: true, status: 'sent', alreadySent: true, sentAt: iso(e?.qbPaidEmailSentAt), ...base }
      : { ok: false, status: st === 'uncertain' ? 'uncertain' : st === 'sending' ? 'sending' : 'error', block: st === 'uncertain' ? 'unconfirmed' : 'sending', ...base, error: e?.qbPaidEmailError ?? 'Another paid-invoice email attempt took over. Check the status again.' }
  }
  try {
    if (r.needsFill) await fillRetailInvoiceEmail(String(v.raw.Id), v.raw.SyncToken, recipient)   // fills ONLY BillEmail
    const sent = await sendRetailInvoiceInQB(String(v.raw.Id), recipient, { timeoutMs: PAYMENT_WRITE_TIMEOUT_MS })
    const sentAt = new Date()
    const applied = await setState({ qbPaidEmailStatus: 'sent', qbPaidEmailTo: recipient, qbPaidEmailSentAt: sentAt, qbPaidEmailError: null })
    // QuickBooks accepted this send — audited as a fact even if a newer attempt already owns the state.
    await logEvent({ serviceOrderId: orderId, eventType: resend ? 'invoice_paid_email_resent' : 'invoice_paid_email_sent', employeeName: actor, note: `#${sent.invoiceNumber ?? est.qbInvoiceNumber} (${est.qbInvoiceId}) PAID invoice → ${recipient} · QuickBooks ${sent.emailStatus}${applied ? '' : ' · late response (state already updated by a newer attempt)'}` })
    logger.info(APP, 'paid_email_sent', { orderId, invoiceId: est.qbInvoiceId, applied })
    return applied ? { ok: true, status: 'sent', sentAt: sentAt.toISOString(), ...base } : superseded()
  } catch (err) {
    const msg = safeErr(err)
    const ambiguous = isAmbiguousWriteError(err)
    if (ambiguous) {
      // Maybe sent: QuickBooks' delivery timestamp must be strictly newer than the one seen at lock time.
      const inv = await getRetailInvoiceRaw(String(est.qbInvoiceId)).catch(() => null)
      if (inv && deliveredSince(inv, { since: lockAt, prior: priorDelivery })) {
        if (!(await setState({ qbPaidEmailStatus: 'sent', qbPaidEmailTo: recipient, qbPaidEmailSentAt: new Date(inv.DeliveryInfo!.DeliveryTime!), qbPaidEmailError: null }))) return superseded()
        await logEvent({ serviceOrderId: orderId, eventType: 'invoice_paid_email_reconciled', employeeName: actor, note: `#${est.qbInvoiceNumber} paid invoice email confirmed by QuickBooks DeliveryInfo after an unconfirmed response` }).catch(() => {})
        return { ok: true, status: 'sent', ...base }
      }
    }
    // The payment is untouched — only the email state records the failure.
    if (!(await setState({ qbPaidEmailStatus: ambiguous ? 'uncertain' : 'error', qbPaidEmailError: msg }))) return superseded()
    await logEvent({ serviceOrderId: orderId, eventType: ambiguous ? 'invoice_paid_email_uncertain' : 'invoice_paid_email_failed', employeeName: actor, note: `#${est.qbInvoiceNumber} → ${recipient}: ${msg}` }).catch(() => {})
    logger.error(APP, 'paid_email_failed', { orderId, error: msg, ambiguous })
    return ambiguous
      ? { ok: false, status: 'uncertain', block: 'unconfirmed', unconfirmed: true, ...base, error: 'QuickBooks did not confirm the email. It may still have been sent, so it will not be sent again automatically. Check again in a minute, or choose “Send another copy”. The payment is still recorded.' }
      : { ok: false, status: 'error', block: 'send_failed', ...base, error: `The email was not sent: ${msg}. The payment is still recorded.` }
  }
}
