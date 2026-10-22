/**
 * Retail Record Payment + Email Paid Invoice — orchestration (manager/admin, route-enforced).
 *
 * Record Payment applies ONE QuickBooks Payment per installment actually collected — the full open balance or
 * a smaller amount — to the job's EXISTING invoice, with the chosen method (cash / card terminal / check) and
 * its owner-mapped deposit account. A later installment (any method) is another Payment on the SAME invoice.
 * It records money already collected and never charges a card. "Paid" is shown only after QuickBooks reports a
 * zero balance; a confirmed installment that leaves a balance is "Partially paid".
 *
 * Duplicate-proof under double-taps, concurrent devices, retries and ambiguous timeouts:
 *   1. reconcile FIRST — read the invoice + its payments. A zero balance (paid online, recorded in QuickBooks,
 *      or by an earlier attempt) is ADOPTED, never paid again. An earlier unconfirmed attempt is confirmed only
 *      by ITS OWN QuickBooks Payment (PSPAY tag carrying its attempt id, applied to this invoice) — never by a
 *      balance reduction, which another payment or a credit could have caused;
 *   2. the open balance the person confirmed must still be QuickBooks' balance — otherwise nothing is written
 *      and the new balance comes back for renewed confirmation;
 *   3. compare-and-set qb_payment_status → 'recording' (one winner; a stale lock is an interrupted attempt);
 *   4. every installment gets its own attempt id, sent as QBO `requestid` and tagged in PrivateNote. An
 *      UNCERTAIN attempt is retried only with the SAME id, method and amount, so QuickBooks itself returns the
 *      original payment; until it is resolved no other installment can start;
 *   5. definite failures → 'error' (safe to retry); ambiguous failures → 'uncertain' (reconciled first);
 *   6. the payment lock and the invoice-changing locks (Sync, charge changes — see invoice-locks.ts) exclude
 *      each other; once any payment or credit is applied the invoice stays frozen (qb_payment_balance_state);
 *      the invoice + draft are re-verified UNDER the lock; every state write is fenced by (attempt id, lock
 *      time), so a stale worker never overwrites a newer attempt's state.
 *
 * The latest ATTEMPT (qb_payment_status) and the invoice's AGGREGATE (qb_payment_balance_state + amounts,
 * cached from QuickBooks reads) are separate columns; the paid-invoice email has its own. Per-payment history
 * is read from QuickBooks; the audit is append-only in service_order_events. Job status / completedAt are
 * never touched. Dealer jobs are refused (Dealer Check-In owns them).
 *
 * Card-payment charge: the existing full-payment rule is unchanged — Cash / Check paying an UNPAID invoice in
 * full removes the un-waived charge (pricing engine) before paying. A partial or later installment never
 * changes the invoice: the confirmed total, charge included, stays as is (mixed-method fee policy is an open
 * owner decision — see docs/retail-invoice-payment.md).
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
  attemptIdForConfirmation, availableMethods, findAttemptPayment, findConfirmationPayment, isAmbiguousWriteError, isConfirmationKey, isPaymentMethodKey, lockIsStale, linkedPaymentIds,
  parsePaymentMappings, paymentTag, deliveredSince, summarizeInvoicePayments, validCents,
  PAID_METHOD_LABEL, PAYMENT_WRITE_TIMEOUT_MS, RECORDING_STALE_MS, SENDING_STALE_MS,
  type InvoiceBalanceState, type InvoiceBalanceSummary, type MethodAvailability, type PaidMethod, type PaymentHistoryEntry,
  type PaymentMethodKey, type QbPayment,
} from './retail-payment'

const APP = 'quickbooks:retail-payment-service'
const safeErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const money = (c: number) => `$${(c / 100).toFixed(2)}`
const newAttemptId = () => crypto.randomUUID()

export type PaymentBlock =
  | 'no_invoice' | 'dealer' | 'not_priced' | 'needs_review' | 'sync_needed' | 'invoice_missing' | 'identity_mismatch'
  | 'customer_mismatch' | 'total_mismatch' | 'invalid_method' | 'invalid_amount' | 'over_balance' | 'balance_changed'
  | 'not_configured' | 'mapping_invalid' | 'invalid_balance' | 'amount_changed' | 'recording' | 'qb_read_failed'
  | 'record_failed' | 'pricing_unresolved' | 'attempt_unresolved' | 'invoice_busy' | 'shared_pending' | 'shared_member_unready'

/** The invoice as QuickBooks reports it, for the phone sheet (history newest last). */
export interface PaymentBalanceView {
  state: InvoiceBalanceState
  totalCents: number
  balanceCents: number
  receivedCents: number
  creditCents: number
  history: Array<PaymentHistoryEntry & { methodLabel: string }>
}

export interface PaymentResult {
  ok: boolean
  /** paid = QuickBooks confirmed zero balance. recorded = THIS installment confirmed, a balance remains.
   *  partial (preview) = payments applied, balance open. uncertain/review = NOT confirmed (never shown as Paid). */
  status: 'paid' | 'recorded' | 'partial' | 'unpaid' | 'recording' | 'uncertain' | 'review' | 'error' | 'refused'
  block?: PaymentBlock
  error?: string
  invoiceId?: string | null
  invoiceNumber?: string | null
  amountCents?: number
  method?: PaidMethod | null
  methodLabel?: string | null
  paymentId?: string | null
  /** Confirmed from QuickBooks before/without this request writing (paid elsewhere, or an earlier attempt that
   *  QuickBooks did record) → adopted, nothing new written. */
  reconciled?: boolean
  alreadyPaid?: boolean
  /** QuickBooks' invoice numbers + payment history after this request. */
  balance?: PaymentBalanceView
}

export interface PaymentPreview extends PaymentResult {
  methods?: MethodAvailability[]
  /** An earlier attempt QuickBooks hasn't confirmed: it can only be checked / retried as this method + amount. */
  pendingMethod?: PaymentMethodKey | null
  pendingAmountCents?: number | null
  /** The invoice still carries a card-payment charge (relevant when the customer pays cash/check). */
  cardChargeCents?: number
  cardChargeLabel?: string
  /** The FULL-payment amount per method — Cash / Check with the card charge removed when the invoice is unpaid
   *  (pricing engine projection; nothing is changed until Save). The sheet's default "Amount received". */
  methodAmounts?: Record<PaymentMethodKey, number>
  /** How much Cash / Check in full saves (the un-waived card charge, incl. any effect on tax); 0 = nothing removed. */
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

/** Owner-mapped QuickBooks PaymentMethod id → Cash / Check / Card Terminal (labels payments entered in QuickBooks).
 *  Only when the mapping is pinned to the connected company. */
async function methodIdsForLabels(): Promise<Record<string, PaymentMethodKey>> {
  const { cfg, methods } = await loadMethods().catch(() => ({ cfg: null, methods: [] as MethodAvailability[] }))
  const out: Record<string, PaymentMethodKey> = {}
  for (const m of methods) { const map = cfg?.methods[m.key]; if (m.available && map) out[map.paymentMethodId] = m.key }
  return out
}

interface PaymentRead { raw: RawQBInvoice; payments: QbPayment[]; summary: InvoiceBalanceSummary | null; invalid: string | null }

/** Read QuickBooks' current payment picture for the linked invoice (fresh invoice + its payments). */
async function readPaymentState(est: EstimateRow, raw?: RawQBInvoice | null): Promise<PaymentRead | null> {
  const inv = raw ?? await getRetailInvoiceRaw(est.qbInvoiceId!)
  if (!inv) return null
  const payments = await loadInvoicePayments({ linkedIds: linkedPaymentIds(inv), customerId: inv.CustomerRef?.value ?? null, estimateId: est.id })
  const s = summarizeInvoicePayments({ invoice: inv, payments, estimateId: est.id, methodIds: await methodIdsForLabels() })
  return { raw: inv, payments, summary: s.ok ? s.summary : null, invalid: s.ok ? null : s.reason }
}

const view = (s: InvoiceBalanceSummary): PaymentBalanceView => ({
  state: s.state, totalCents: s.totalCents, balanceCents: s.balanceCents, receivedCents: s.receivedCents, creditCents: s.creditCents,
  history: s.history.map((h) => ({ ...h, methodLabel: PAID_METHOD_LABEL[h.method] })),
})
/** The cached aggregate written with every QuickBooks-confirmed read. */
const balancePatch = (s: InvoiceBalanceSummary) => ({
  qbPaymentBalanceState: s.state, qbPaymentTotalCents: s.totalCents, qbPaymentBalanceCents: s.balanceCents,
  qbPaymentReceivedCents: s.receivedCents, qbPaymentCreditCents: s.creditCents, qbPaymentCheckedAt: new Date(),
})

/** The payment shown for a zero balance reached outside this attempt: the latest one applied (paid online, in
 *  QuickBooks, or a credit). No readable payment (e.g. a credit memo applied directly) — still paid per QuickBooks. */
function latestApplied(s: InvoiceBalanceSummary): Confirmation {
  const h = s.history[s.history.length - 1]
  return h ? { paymentId: h.paymentId, method: h.method, amountCents: h.appliedCents } : { paymentId: null, method: 'other', amountCents: s.totalCents }
}

/**
 * Which payment state a write may replace: the exact state the caller observed before taking its QuickBooks
 * snapshot (status + attempt id + lock time). Anything newer — a takeover, a review flag, another attempt —
 * makes the write a no-op, so an old snapshot can never overwrite newer payment state.
 */
interface PaymentFence { statuses: string[]; requestId: string | null; startedAt: Date | null }
const observedFence = (est: EstimateRow): PaymentFence => ({ statuses: [est.qbPaymentStatus], requestId: est.qbPaymentRequestId ?? null, startedAt: est.qbPaymentStartedAt ?? null })
const fenceWhere = (estId: string, f: PaymentFence) => and(
  eq(jobEstimates.id, estId), inArray(jobEstimates.qbPaymentStatus, f.statuses),
  f.requestId == null ? isNull(jobEstimates.qbPaymentRequestId) : eq(jobEstimates.qbPaymentRequestId, f.requestId),
  f.startedAt == null ? isNull(jobEstimates.qbPaymentStartedAt) : eq(jobEstimates.qbPaymentStartedAt, f.startedAt),
)

interface Confirmation { paymentId: string | null; method: PaidMethod; amountCents: number }

/**
 * Persist a QuickBooks-confirmed payment — an installment just recorded (or found after a lost response), or a
 * zero balance adopted — only over the state the caller observed (see PaymentFence). Zero balance → 'paid';
 * otherwise 'recorded' (this installment confirmed, balance open). Returns whether the state is now this
 * confirmation; the audit event is written only for a transition that actually happened.
 */
async function markConfirmed(est: EstimateRow, c: Confirmation, s: InvoiceBalanceSummary, actor: string | null, how: 'recorded' | 'reconciled', fence: PaymentFence): Promise<boolean> {
  const paid = s.state === 'paid'
  const status = paid ? 'paid' : 'recorded'
  const fresh = await getEstimateRow(est.serviceOrderId)
  if (fresh?.qbPaymentStatus === status && fresh.qbPaymentId === c.paymentId) return true
  const done = await getDb().update(jobEstimates).set({
    qbPaymentStatus: status, qbPaymentId: c.paymentId, qbPaymentMethod: c.method, qbPaymentAmountCents: c.amountCents, qbPaymentError: null,
    ...(paid ? { qbPaidAt: fresh?.qbPaidAt ?? new Date(), qbPaidBy: how === 'recorded' ? actor : (fresh?.qbPaidBy ?? null) } : {}),
    ...balancePatch(s), updatedAt: new Date(),
  }).where(fenceWhere(est.id, fence)).returning({ id: jobEstimates.id })
  if (done.length === 0) {
    logger.warn(APP, 'confirmed_write_superseded', { orderId: est.serviceOrderId, paymentId: c.paymentId, how })
    return false
  }
  const what = how === 'recorded' ? (paid ? 'paid in full' : 'installment recorded') : (paid ? 'already paid in QuickBooks' : 'payment found in QuickBooks')
  await logEvent({
    serviceOrderId: est.serviceOrderId,
    eventType: how === 'recorded' ? 'invoice_payment_recorded' : 'invoice_payment_reconciled',
    employeeName: actor,
    note: `#${est.qbInvoiceNumber} (${est.qbInvoiceId}) ${what} · ${PAID_METHOD_LABEL[c.method]} · ${money(c.amountCents)}${c.paymentId ? ` · QB payment ${c.paymentId}` : ''} · balance ${money(s.balanceCents)} of ${money(s.totalCents)}`,
  }).catch(() => {})
  return true
}

/** Refresh the cached aggregate from a QuickBooks read — fenced like any state write (best effort). */
async function cacheBalance(estId: string, s: InvoiceBalanceSummary, fence: PaymentFence): Promise<void> {
  await getDb().update(jobEstimates).set({ ...balancePatch(s), updatedAt: new Date() }).where(fenceWhere(estId, fence)).catch(() => {})
}

/** What the job's payment state is NOW — reported when this request's write was superseded by newer state. */
async function currentPaymentResult(orderId: string): Promise<PaymentResult> {
  const e = await getEstimateRow(orderId)
  const base = { invoiceId: e?.qbInvoiceId ?? null, invoiceNumber: e?.qbInvoiceNumber ?? null }
  const last = { amountCents: e?.qbPaymentAmountCents ?? undefined, method: e?.qbPaymentMethod as PaidMethod, methodLabel: PAID_METHOD_LABEL[e?.qbPaymentMethod as PaidMethod] ?? null, paymentId: e?.qbPaymentId }
  if (e?.qbPaymentStatus === 'paid') return { ok: true, status: 'paid', alreadyPaid: true, ...base, ...last }
  if (e?.qbPaymentStatus === 'recorded') return { ok: true, status: 'recorded', ...base, ...last }
  if (e?.qbPaymentStatus === 'review') return { ok: false, status: 'review', ...base, error: e.qbPaymentError ?? 'This payment needs review in QuickBooks.' }
  if (e?.qbPaymentStatus === 'uncertain') return { ok: false, status: 'uncertain', ...base, error: e.qbPaymentError ?? 'QuickBooks has not confirmed the payment yet. Tap Check again.' }
  if (e?.qbPaymentStatus === 'recording') return { ok: false, status: 'recording', block: 'recording', ...base, error: 'A payment is being recorded for this invoice.' }
  return { ok: false, status: 'refused', block: 'amount_changed', ...base, error: 'The payment state changed while checking. Open Record Payment again.' }
}

function confirmedResult(est: EstimateRow, c: Confirmation, s: InvoiceBalanceSummary, extra: Partial<PaymentResult> = {}): PaymentResult {
  return {
    ok: true, status: s.state === 'paid' ? 'paid' : 'recorded', invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber,
    amountCents: c.amountCents, method: c.method, methodLabel: PAID_METHOD_LABEL[c.method], paymentId: c.paymentId, balance: view(s), ...extra,
  }
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
  shared_pending: 'A linked vehicle’s charges are not on this invoice yet. Review and update the shared invoice (or keep that vehicle separate) before recording a payment.',
  shared_member_unready: 'A vehicle on this shared invoice isn’t priced. Fix it and update the shared invoice first.',
}

/**
 * Verify the linked invoice, read QuickBooks' payment state, then:
 *   - an earlier unconfirmed attempt that QuickBooks DID record (found by its own attempt id) is confirmed;
 *   - a zero balance is adopted (no payment written) — before any draft check, so an invoice paid in full
 *     elsewhere is never stuck behind a local edit;
 *   - a job marked Paid whose QuickBooks balance has reopened (payment deleted / refunded) goes to review —
 *     never shown as Paid while money is owed;
 *   - while NO money is applied, the invoice must still match the authoritative Invoice Draft (priced, synced,
 *     same total). Once any payment or credit is applied the invoice is frozen (Sync refuses), so later
 *     installments are recorded against QuickBooks' invoice exactly as it stands — identity + customer only.
 * `confirmed` = an earlier attempt was just confirmed here and a balance remains (nothing new was written).
 */
async function verifyAndReconcile(orderId: string, actor: string | null, opts: { allowDrift?: boolean } = {}): Promise<
  | { ok: false; result: PaymentResult }
  | { ok: true; v: VerifiedLinkedInvoice; summary: InvoiceBalanceSummary; read: PaymentRead; confirmed: PaymentResult | null }
> {
  const est0 = await getEstimateRow(orderId)
  const refused = (block: PaymentBlock, ids?: { invoiceId?: string | null; invoiceNumber?: string | null }): { ok: false; result: PaymentResult } =>
    ({ ok: false, result: { ok: false, status: 'refused', block, error: BLOCK_MSG[block] ?? 'This invoice can’t take a payment right now.', invoiceId: ids?.invoiceId ?? null, invoiceNumber: ids?.invoiceNumber ?? null } })
  // Identity + customer first (the invoice being paid is this job's, for this customer).
  const light = await verifyLinkedRetailInvoice(orderId, { paidInvoice: true })
  if (!light.ok) {
    // A job already confirmed paid stays paid if QuickBooks can't be re-verified right now — report it, don't hide it.
    if (est0?.qbPaymentStatus === 'paid') return { ok: false, result: { ok: true, status: 'paid', alreadyPaid: true, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, amountCents: est0.qbPaymentAmountCents ?? undefined, method: est0.qbPaymentMethod as PaidMethod, methodLabel: est0.qbPaymentMethod ? PAID_METHOD_LABEL[est0.qbPaymentMethod as PaidMethod] ?? null : null, paymentId: est0.qbPaymentId } }
    return refused((light.block ?? 'qb_read_failed') as PaymentBlock, light)
  }
  let read
  try { read = await readPaymentState(light.est, light.raw) }
  catch (e) { return { ok: false, result: { ok: false, status: 'refused', block: 'qb_read_failed', error: `Could not check QuickBooks payments: ${safeErr(e)}` } } }
  if (!read) return refused('invoice_missing')
  const s = read.summary
  if (!s) return { ok: false, result: { ok: false, status: 'refused', block: 'invalid_balance', error: read.invalid ?? 'QuickBooks returned an unreadable balance.' } }
  const est = light.est
  // Writes below replace only the state observed before this snapshot was read; a newer review / attempt survives.
  const fence = observedFence(est)

  // An earlier unconfirmed attempt: confirmed ONLY by its own QuickBooks Payment — never by the balance.
  const open = unresolvedAttempt(est)
  const mine = open ? findAttemptPayment(read.payments, { invoiceId: String(read.raw.Id), estimateId: est.id, attemptId: open.attemptId }) : null
  let confirmed: PaymentResult | null = null
  if (open && mine) {
    if (open.amountCents != null && mine.appliedCents !== open.amountCents) {
      const msg = `QuickBooks payment ${mine.paymentId} for this attempt shows ${money(mine.appliedCents)} applied, not the ${money(open.amountCents)} confirmed — review it in QuickBooks.`
      const flagged = await getDb().update(jobEstimates).set({ qbPaymentStatus: 'review', qbPaymentId: mine.paymentId, qbPaymentError: msg, ...balancePatch(s), updatedAt: new Date() }).where(fenceWhere(est.id, fence)).returning({ id: jobEstimates.id })
      if (flagged.length) await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_review', employeeName: actor, note: msg }).catch(() => {})
      return { ok: false, result: { ok: false, status: 'review', error: msg, invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber, balance: view(s) } }
    }
    const c: Confirmation = { paymentId: mine.paymentId, method: mine.method, amountCents: mine.appliedCents }
    if (!(await markConfirmed(est, c, s, actor, 'recorded', fence))) return { ok: false, result: await currentPaymentResult(orderId) }
    confirmed = confirmedResult(est, c, s, { reconciled: true })
    if (s.state === 'paid') return { ok: false, result: confirmed }
  } else if (open && s.state === 'paid') {
    // A dangling unconfirmed attempt whose OWN payment is not in QuickBooks, while the balance is now zero
    // (paid by something else): we can neither confirm nor clear it from the balance — it may have recorded a
    // payment not visible yet, or the zero balance is unrelated and our attempt could still be a duplicate.
    // Keep the attempt unresolved (aggregate cached separately); never emit a paid receipt for it.
    await cacheBalance(est.id, s, fence)
    return { ok: true, v: light, summary: s, read, confirmed: null }
  } else if (s.state === 'paid') {
    // Adopt a zero balance (paid online / in QuickBooks / an earlier lost response) — never pay again.
    const c = latestApplied(s)
    if (!(await markConfirmed(est, c, s, actor, 'reconciled', fence))) return { ok: false, result: await currentPaymentResult(orderId) }
    return { ok: false, result: confirmedResult(est, c, s, { reconciled: est.qbPaymentStatus !== 'paid', alreadyPaid: true }) }
  } else if (est.qbPaymentStatus === 'paid') {
    // Marked Paid, but QuickBooks shows money owed again (a payment deleted or refunded there): review — never Paid.
    const msg = `This invoice was marked paid, but QuickBooks now shows ${money(s.balanceCents)} open — review the payments in QuickBooks.`
    const flagged = await getDb().update(jobEstimates).set({ qbPaymentStatus: 'review', qbPaymentError: msg, ...balancePatch(s), updatedAt: new Date() }).where(fenceWhere(est.id, fence)).returning({ id: jobEstimates.id })
    if (flagged.length) await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_review', employeeName: actor, note: msg }).catch(() => {})
    return { ok: false, result: { ok: false, status: 'review', error: msg, invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber, balance: view(s) } }
  }

  let v: VerifiedLinkedInvoice = light
  if (s.state === 'unpaid') {
    // Nothing applied yet: the invoice must still be the authoritative Invoice Draft's, and the draft settled —
    // an unfinished breakdown or an itemized total that differs from the agreed amount is not an amount to collect.
    const full = await verifyLinkedRetailInvoice(orderId, opts.allowDrift ? { allowDrift: true } : {})
    if (!full.ok) return refused((full.block ?? 'qb_read_failed') as PaymentBlock, full)
    if (full.draft.pricingIncomplete || full.draft.referenceCents != null || flatPricingIssue(full.full)) {
      return { ok: false, result: { ok: false, status: 'refused', block: 'pricing_unresolved', invoiceId: full.est.qbInvoiceId, invoiceNumber: full.est.qbInvoiceNumber, error: full.draft.pricingIncomplete ? 'Finish pricing every service before recording a payment.' : 'The itemized total differs from the agreed amount. Resolve it in the Estimate (and sync the invoice) before recording a payment.' } }
    }
    v = full
  }
  if (!confirmed) await cacheBalance(est.id, s, fence)
  return { ok: true, v, summary: s, read, confirmed }
}

/** Methods paid without a card: paying an unpaid invoice IN FULL removes the card-payment charge first. */
const REMOVES_CARD_FEE: readonly PaymentMethodKey[] = ['cash', 'check']
/** Written (with the waiver) while the fee-removed invoice is not yet synced — the Invoice Draft shows it. */
const FEE_SYNC_MSG = 'QuickBooks sync needed — card-payment charge removed for a cash/check payment.'

/** Cash / Check total: the authoritative engine's total with the card-payment charge removed (no writes).
 *  Null when there is no un-waived charge to remove (none configured, or already waived — kept as-is). */
async function cashTotalCents(v: VerifiedLinkedInvoice): Promise<number | null> {
  // A shared invoice bills several Jobs, each with its own card charge: the automatic removal (one Job's pricing
  // engine + one Job's sync) can't express that, so it is not offered — the person removes each Job's charge on
  // its Invoice Draft and updates the shared invoice first. The amount due is then exactly QuickBooks' balance.
  if (v.shared) return null
  const charge = v.draft.paymentCharge
  if (charge.waived || !(charge.cents > 0)) return null
  return projectEstimateTotalCents(v.est.id, { waiveCardFee: true })
}

/** An unresolved attempt that already removed the card charge locally: QuickBooks may or may not carry the
 *  new total yet. It is resumed (re-sync, then pay with the same attempt id), never redone differently. */
const resumesFeeRemoval = (est: EstimateRow) => !!unresolvedAttempt(est) && est.qbPaymentCardFeeRemoved

/**
 * READ path behind "Record Payment" (runs when the sheet opens, and as "Check again"): verifies the invoice,
 * reconciles payments already in QuickBooks, and returns the invoice total, payments/credits, open balance,
 * payment history, the full-payment amount per method (Cash / Check on an unpaid invoice: card charge removed,
 * computed by the pricing engine) and the methods that may be recorded. Writes only local reconciliation
 * state — never a QuickBooks write, never a charge change.
 */
export async function previewRetailPayment(params: { orderId: string; actor: string | null }): Promise<PaymentPreview> {
  const { orderId, actor } = params
  const est = await getEstimateRow(orderId)
  if (!est?.qbInvoiceId) return { ok: false, status: 'refused', block: 'no_invoice', error: BLOCK_MSG.no_invoice }
  const r = await verifyAndReconcile(orderId, actor, { allowDrift: resumesFeeRemoval(est) })
  if (!r.ok) return r.result
  const { methods } = await loadMethods()
  const fresh = await getEstimateRow(orderId)
  const pending = fresh?.qbPaymentStatus === 'recording' && !lockIsStale(fresh.qbPaymentStartedAt, Date.now(), RECORDING_STALE_MS)
  const unresolved = fresh ? unresolvedAttempt(fresh) : null
  const s = r.summary
  const status: PaymentResult['status'] = pending ? 'recording' : unresolved ? 'uncertain' : fresh?.qbPaymentStatus === 'review' ? 'review' : s.state === 'partial' ? 'partial' : 'unpaid'
  const charge = r.v.draft.paymentCharge
  const balance = s.balanceCents
  let methodAmounts: Record<PaymentMethodKey, number>
  let cardFeeRemovalCents = 0
  if (fresh && resumesFeeRemoval(fresh)) {
    // Resuming: the charge is already removed; the pinned attempt's amount is the only amount.
    const pinned = unresolved?.amountCents ?? r.v.draft.totalCents
    methodAmounts = { cash: pinned, check: pinned, card_terminal: pinned }
  } else {
    // Card-charge removal belongs to paying an UNPAID invoice in full; after any installment the invoice stays as is.
    const cash = s.state === 'unpaid' ? await cashTotalCents(r.v) : null
    if (cash != null) cardFeeRemovalCents = balance - cash
    methodAmounts = { cash: cash ?? balance, check: cash ?? balance, card_terminal: balance }
  }
  return {
    ok: true, status, invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber, amountCents: balance, methods,
    pendingMethod: unresolved?.method ?? null, pendingAmountCents: unresolved?.amountCents ?? null,
    error: r.confirmed ? undefined : fresh?.qbPaymentError ?? undefined,
    cardChargeCents: !charge.waived && charge.cents > 0 ? charge.cents : 0, cardChargeLabel: charge.label,
    methodAmounts, cardFeeRemovalCents, cardFeeRemoved: !!fresh?.qbPaymentCardFeeRemoved && !!unresolved,
    balance: view(s),
    ...(r.confirmed ? { reconciled: true, paymentId: r.confirmed.paymentId, method: r.confirmed.method, methodLabel: r.confirmed.methodLabel } : {}),
  }
}

/**
 * Record one installment of money already collected.
 *
 * Installment clients send `amountCents` (the "Amount received" the person confirmed) and `balanceCents` (the
 * open balance they saw). If QuickBooks' balance differs now, nothing is written and the new balance comes back
 * for renewed confirmation. Zero / negative / fractional / over-balance amounts are refused. Older clients send
 * only `confirmedAmountCents`, which keeps its original meaning: the full-payment amount for that method.
 *
 * Cash / Check paying an UNPAID invoice in full, with an un-waived card-payment charge: under the payment lock,
 * (a) re-check QuickBooks, (b) remove the charge through the pricing engine, (c) sync the SAME invoice, (d) verify
 * QuickBooks now equals the confirmed total, then (e) pay it with the attempt id. If the invoice update definitely
 * did not happen, the charge is restored and nothing is recorded; if it may have happened, the attempt stays
 * pinned (method + amount + id) and a retry re-syncs (a no-op if it landed) before paying. Any smaller amount, and
 * any later installment, records the Payment against the invoice exactly as it stands.
 */
export async function recordRetailPayment(params: {
  orderId: string; actor: string | null; method: unknown
  amountCents?: unknown; balanceCents?: unknown; confirmedAmountCents?: unknown
  /** One id per Review → Save on the phone, reused by every retry of that confirmation. */
  confirmationId?: unknown
  /** What the person confirmed: pay the invoice in full ('full') or record a smaller installment ('partial'). */
  intent?: unknown
}): Promise<PaymentResult> {
  const { orderId, actor } = params
  const db = getDb()
  if (!isPaymentMethodKey(params.method)) return { ok: false, status: 'refused', block: 'invalid_method', error: 'Choose Cash, Card Terminal or Check.' }
  const method: PaymentMethodKey = params.method
  const label = PAID_METHOD_LABEL[method]
  const legacy = params.amountCents === undefined
  const amount = validCents(legacy ? params.confirmedAmountCents : params.amountCents)
  const seenBalance = legacy ? null : validCents(params.balanceCents)
  if (amount == null) return { ok: false, status: 'refused', block: 'invalid_amount', error: 'Enter the amount received — more than $0.00, in dollars and cents.' }
  if (!legacy && seenBalance == null) return { ok: false, status: 'refused', block: 'invalid_amount', error: 'The open balance was not confirmed. Open Record Payment again.' }
  const confirmKey = isConfirmationKey(params.confirmationId) ? params.confirmationId : null
  const intent = params.intent === 'full' || params.intent === 'partial' ? params.intent : null

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
  const { v, summary: s } = r
  const balance = s.balanceCents
  const ids = { invoiceId: v.est.qbInvoiceId, invoiceNumber: v.est.qbInvoiceNumber }
  // This SAME confirmation already recorded (a retried Save after a lost response): report that payment —
  // never record the same money twice. Found by the QuickBooks payment's own tag, not by the balance.
  if (confirmKey) {
    const prior = findConfirmationPayment(r.read.payments, { invoiceId: String(r.read.raw.Id), estimateId: v.est.id, key: confirmKey })
    if (prior) return confirmedResult(v.est, { paymentId: prior.paymentId, method: prior.method, amountCents: prior.appliedCents }, s, { reconciled: true })
  }
  // An earlier unconfirmed attempt turned out to be in QuickBooks: it is now confirmed — nothing new is written.
  if (r.confirmed) return r.confirmed

  const pending = unresolvedAttempt((await getEstimateRow(orderId))!)
  // A changed balance means renewed confirmation — BUT a dangling unconfirmed attempt is resolved by its own
  // branch below (which never records a second, different payment), so it takes priority over balance_changed.
  if (!pending && seenBalance != null && seenBalance !== balance) {
    return { ok: false, status: 'refused', block: 'balance_changed', amountCents: balance, balance: view(s), ...ids, error: `QuickBooks now shows ${money(balance)} open (you confirmed ${money(seenBalance)}). This payment was not recorded — check the payment history, then the amount, and confirm again.` }
  }

  let target: number           // the amount to record
  let removeFee = false
  if (drift) {
    if (s.state !== 'unpaid') {
      return { ok: false, status: 'uncertain', block: 'attempt_unresolved', ...ids, balance: view(s), error: `An earlier ${label} payment was not confirmed, and QuickBooks now shows other payments on this invoice. Review it in QuickBooks.` }
    }
    target = v.common.draftTotalCents
  } else if (pending) {
    // An unconfirmed earlier installment: only it may be retried — same method, same amount.
    if (pending.amountCents == null || pending.amountCents > balance) {
      return { ok: false, status: 'uncertain', block: 'attempt_unresolved', method: pending.method, methodLabel: PAID_METHOD_LABEL[pending.method], amountCents: pending.amountCents ?? undefined, ...ids, balance: view(s),
        error: `An earlier ${PAID_METHOD_LABEL[pending.method]} payment${pending.amountCents != null ? ` of ${money(pending.amountCents)}` : ''} was not confirmed, and only ${money(balance)} is open now. Review the invoice in QuickBooks.` }
    }
    target = pending.amountCents
  } else {
    // A brand-new installment needs a COHERENT snapshot: QuickBooks' balance must already reflect every payment
    // it reports applied to this invoice. A lagging balance (a recent payment visible as a Payment but not yet
    // in the invoice Balance/LinkedTxn) is stale — recording against it could double up. (A retry of the SAME
    // confirmation, handled above by its tag, is still allowed — it trusts the payment record, not the balance.)
    if (!s.coherent) {
      return { ok: false, status: 'refused', block: 'invoice_busy', ...ids, balance: view(s), error: 'QuickBooks is still catching up on a recent payment to this invoice. Wait a moment, then open Record Payment again — nothing was recorded.' }
    }
    if (s.state === 'unpaid' && balance !== v.common.draftTotalCents) {
      return { ok: false, status: 'refused', block: 'total_mismatch', error: BLOCK_MSG.total_mismatch }
    }
    const cash = REMOVES_CARD_FEE.includes(method) && s.state === 'unpaid' ? await cashTotalCents(v) : null
    const full = cash ?? balance
    // The person confirmed "in full" or "partial" — the server never silently turns one into the other
    // (e.g. a pricing-config change moving the Cash total by a cent between preview and Save).
    if ((intent === 'full' && amount !== full) || (intent === 'partial' && amount === full && cash != null)) {
      return { ok: false, status: 'refused', block: 'amount_changed', amountCents: full, balance: view(s), ...ids,
        error: `Paid in full by ${label} is now ${money(full)}${cash != null ? ` (the ${v.draft.paymentCharge.label ?? 'card'} charge comes off)` : ''}. Nothing was recorded — check the amount and confirm again.` }
    }
    if (legacy || amount === full) {
      target = full; removeFee = cash != null
    } else if (amount > full) {
      return { ok: false, status: 'refused', block: 'over_balance', amountCents: full, balance: view(s), ...ids,
        error: cash != null
          ? `Paid in full by ${label} is ${money(cash)} (the ${v.draft.paymentCharge.label ?? 'card'} charge comes off). Enter ${money(cash)}, or less for a partial payment.`
          : `${money(amount)} is more than the ${money(balance)} still open. Overpayments and tips aren’t recorded here.` }
    } else {
      target = amount   // a partial installment: the invoice — and any card charge on it — stays exactly as confirmed
    }
  }
  // An unconfirmed earlier attempt (QuickBooks doesn't show it — it may yet appear): only that attempt may be
  // retried, as the same method and amount. Never a second, different payment.
  if (pending && (pending.method !== method || (pending.amountCents != null && pending.amountCents !== target))) {
    const pl = PAID_METHOD_LABEL[pending.method]
    return {
      ok: false, status: 'uncertain', block: 'attempt_unresolved', method: pending.method, methodLabel: pl,
      amountCents: pending.amountCents ?? target, ...ids,
      error: pending.method !== method
        ? `An earlier ${pl} payment of ${money(pending.amountCents ?? target)} was not confirmed by QuickBooks yet. Check again, or retry it as ${pl} — a different method can’t be recorded until it is resolved.`
        : `An earlier ${pl} payment of ${money(pending.amountCents!)} was not confirmed, and the amount due is now ${money(target)}. Review the invoice in QuickBooks.`,
    }
  }
  if (amount !== target) {
    if (pending && !legacy) {
      return { ok: false, status: 'uncertain', block: 'attempt_unresolved', method: pending.method, methodLabel: label, amountCents: target, ...ids,
        error: `An earlier ${label} payment of ${money(target)} was not confirmed by QuickBooks yet. Check again, or retry it for ${money(target)} — a different amount can’t be recorded until it is resolved.` }
    }
    return { ok: false, status: 'refused', block: 'amount_changed', amountCents: target, ...ids, error: `The amount due${removeFee ? ` (${label}, card charge removed)` : ''} is now ${money(target)}. Confirm the new amount.` }
  }

  const { cfg, methods } = await loadMethods()
  const avail = methods.find((m) => m.key === method)
  const mapping = cfg.methods[method]
  if (!avail?.available || !mapping) {
    return { ok: false, status: 'refused', block: 'not_configured', error: avail?.reason === 'realm_mismatch' ? 'Payment setup belongs to a different QuickBooks company. An admin must confirm the payment mappings.' : `${label} isn’t set up for QuickBooks yet. An admin must map it first.` }
  }
  const mappingErr = await verifyPaymentMapping(mapping).catch((e) => `Could not verify the payment setup in QuickBooks: ${safeErr(e)}`)
  if (mappingErr) return { ok: false, status: 'refused', block: 'mapping_invalid', error: mappingErr }

  // (2) Lock. An unconfirmed (uncertain / stale) attempt is retried with the SAME attempt id so QuickBooks'
  // requestid de-duplication returns the original payment if it was in fact created. The compare-and-set
  // pins that identity (request id + method + amount) and requires no invoice-changing operation in progress
  // (Sync / create — whose own locks require no payment in progress: see invoice-locks.ts). A new installment
  // may start after a confirmed one ('recorded') or a definite failure.
  const est1 = (await getEstimateRow(orderId))!
  const resume = unresolvedAttempt(est1)
  const resumeAttempt = !!resume
  if ((resume?.attemptId ?? null) !== (pending?.attemptId ?? null) || (resume && !!est1.qbPaymentCardFeeRemoved !== drift)) {
    return { ok: false, status: 'refused', block: 'amount_changed', error: 'The payment state changed while checking. Open Record Payment again.' }
  }
  const attemptId = resume ? resume.attemptId : confirmKey ? attemptIdForConfirmation(confirmKey, est1.qbPaymentRequestId, newAttemptId) : newAttemptId()
  const lockAt = new Date()
  const staleBefore = new Date(lockAt.getTime() - RECORDING_STALE_MS)
  const idle = notInArray(jobEstimates.qbStatus, INVOICE_CHANGING_STATUSES)
  const from = resume
    ? and(eq(jobEstimates.qbPaymentRequestId, resume.attemptId), eq(jobEstimates.qbPaymentMethod, method), eq(jobEstimates.qbPaymentAmountCents, target), or(
        eq(jobEstimates.qbPaymentStatus, 'uncertain'),
        and(eq(jobEstimates.qbPaymentStatus, 'recording'), or(lt(jobEstimates.qbPaymentStartedAt, staleBefore), sql`${jobEstimates.qbPaymentStartedAt} IS NULL`)),
      ))
    : inArray(jobEstimates.qbPaymentStatus, ['none', 'error', 'recorded'])
  const locked = await db.update(jobEstimates)
    .set({ qbPaymentStatus: 'recording', qbPaymentRequestId: attemptId, qbPaymentMethod: method, qbPaymentAmountCents: target, qbPaymentStartedAt: lockAt, qbPaymentError: null, ...(resume ? {} : { qbPaymentCardFeeRemoved: false, qbPaymentId: null }), updatedAt: new Date() })
    .where(and(eq(jobEstimates.id, est1.id), idle, from))
    .returning({ id: jobEstimates.id })
  if (locked.length === 0) {
    const fresh = await getEstimateRow(orderId)
    if (fresh && INVOICE_CHANGING_STATUSES.includes(fresh.qbStatus)) return { ok: false, status: 'refused', block: 'invoice_busy', error: BUSY_MSG }
    if (fresh?.qbPaymentStatus === 'paid') return { ok: true, status: 'paid', alreadyPaid: true, invoiceId: fresh.qbInvoiceId, invoiceNumber: fresh.qbInvoiceNumber, amountCents: fresh.qbPaymentAmountCents ?? undefined, method: fresh.qbPaymentMethod as PaidMethod, methodLabel: PAID_METHOD_LABEL[fresh.qbPaymentMethod as PaidMethod] ?? null, paymentId: fresh.qbPaymentId }
    if (fresh?.qbPaymentStatus === 'review') return { ok: false, status: 'review', error: fresh.qbPaymentError ?? 'This payment needs review in QuickBooks.' }
    return { ok: false, status: 'recording', block: 'recording', error: 'A payment is already being recorded for this invoice.' }
  }
  const partialNote = removeFee || target === balance ? '' : ` · installment (open ${money(balance)} → ${money(balance - target)})`
  await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_attempt', employeeName: actor, note: `#${v.est.qbInvoiceNumber} (${v.est.qbInvoiceId}) ${label} ${money(target)} · attempt ${attemptId}${partialNote}${removeFee ? ` · card charge removed (was ${money(balance)})` : ''}${resumeAttempt ? ' · resumed after unconfirmed attempt' : ''}` }).catch(() => {})

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
  // the lock (both now excluded) must not leave us collecting against a stale invoice.
  // Money already applied: the invoice is frozen and QuickBooks' own total is the reference (identity + total only).
  const frozen = s.state !== 'unpaid'
  const v2 = await verifyLinkedRetailInvoice(orderId, frozen ? { paidInvoice: true } : drift ? { allowDrift: true } : {})
  const v2Stale = !v2.ok || (frozen
    ? v2.common.qbTotalCents !== v.common.qbTotalCents
    : v2.draft.pricingIncomplete || v2.draft.referenceCents != null || flatPricingIssue(v2.full))
    || (frozen ? false : drift
      ? v2.common.draftTotalCents !== target
      : v2.common.draftTotalCents !== v.common.draftTotalCents || v2.common.qbTotalCents !== v.common.qbTotalCents
        || (removeFee && (await cashTotalCents(v2)) !== target))
  if (v2Stale) {
    await release()
    const block = (!v2.ok ? (v2.block ?? 'qb_read_failed') : 'amount_changed') as PaymentBlock
    return { ok: false, status: 'refused', block, ...ids, error: !v2.ok ? (BLOCK_MSG[block] ?? 'This invoice can’t take a payment right now.') : 'The invoice changed while saving. Nothing was recorded — open Record Payment again.' }
  }

  // (4) Re-reconcile under the lock (a concurrent payment / an earlier lost response) — BEFORE any charge change.
  let under
  try { under = await readPaymentState(v.est) }
  catch (e) {
    if (!(await setState({ qbPaymentStatus: resumeAttempt ? 'uncertain' : 'error', qbPaymentError: `Could not check QuickBooks before saving: ${safeErr(e)}` }))) return currentPaymentResult(orderId)
    return { ok: false, status: resumeAttempt ? 'uncertain' : 'error', block: 'qb_read_failed', error: 'Could not check QuickBooks before saving. Nothing was recorded — try again.' }
  }
  /** Continue only if QuickBooks still shows the balance this installment was confirmed against (`expected`;
   *  null = must still be fully unpaid). THIS attempt already in QuickBooks → confirmed, never paid again; a zero
   *  balance → adopted; anything else → nothing written, renewed confirmation. */
  const adoptOrRefuse = async (u: PaymentRead | null, expected: number | null): Promise<PaymentResult | null> => {
    const us = u?.summary
    if (u && us) {
      const mine = findAttemptPayment(u.payments, { invoiceId: String(u.raw.Id), estimateId: v.est.id, attemptId })
      if (mine && mine.appliedCents === target) {
        const c: Confirmation = { paymentId: mine.paymentId, method, amountCents: target }
        if (!(await markConfirmed(v.est, c, us, actor, 'recorded', lockFence))) return currentPaymentResult(orderId)
        return confirmedResult(v.est, c, us)
      }
      if (mine) {
        const msg = `QuickBooks payment ${mine.paymentId} for this attempt shows ${money(mine.appliedCents)} applied, not ${money(target)} — review it in QuickBooks.`
        if (!(await setState({ qbPaymentStatus: 'review', qbPaymentId: mine.paymentId, qbPaymentError: msg, ...balancePatch(us) }))) return currentPaymentResult(orderId)
        await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_review', employeeName: actor, note: msg }).catch(() => {})
        return { ok: false, status: 'review', paymentId: mine.paymentId, error: msg, balance: view(us) }
      }
      if (us.state !== 'paid' && (expected == null ? us.state === 'unpaid' : us.balanceCents === expected)) return null
      if (us.state === 'paid') {
        // A zero balance NOT reached by our own payment: adopt it only when this is a FRESH attempt (we have
        // written nothing, so there is no payment of ours to double up). When resuming an unconfirmed attempt,
        // our earlier payment might also exist — never confirm from the balance; a person reviews a duplicate.
        if (resumeAttempt) {
          const msg = `QuickBooks shows this invoice paid, but the earlier ${label} payment of ${money(target)} was never confirmed — review it in QuickBooks for a possible duplicate before recording anything else.`
          if (!(await setState({ qbPaymentStatus: 'review', qbPaymentError: msg, ...balancePatch(us) }))) return currentPaymentResult(orderId)
          await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_review', employeeName: actor, note: msg }).catch(() => {})
          return { ok: false, status: 'review', error: msg, balance: view(us) }
        }
        const c = latestApplied(us)
        if (!(await markConfirmed(v.est, c, us, actor, 'reconciled', lockFence))) return currentPaymentResult(orderId)
        return confirmedResult(v.est, c, us, { reconciled: true, alreadyPaid: true })
      }
    }
    if (!(await releaseRestoringFee())) return currentPaymentResult(orderId)
    return { ok: false, status: 'refused', block: 'balance_changed', amountCents: us?.balanceCents, balance: us ? view(us) : undefined, ...ids, error: 'QuickBooks changed while saving. Nothing was recorded — check the balance and confirm again.' }
  }
  const early = await adoptOrRefuse(under, drift ? null : balance)
  if (early) return early
  let payRaw = under!.raw

  // (5) Cash / Check in full: remove the card charge (pricing engine), sync the SAME invoice, verify QuickBooks.
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
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_override', employeeName: actor, note: JSON.stringify({ field: 'Payment charge', key: 'payment', action: 'removed', old: false, new: true, via: 'record_payment', method, attempt: attemptId, reason: `Paid by ${label} — card-payment charge removed` }) }).catch(() => {})
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
        await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_failed', employeeName: actor, note: `${label} ${money(target)} · invoice update failed, card charge restored: ${why}` }).catch(() => {})
        return { ok: false, status: 'error', block: 'record_failed', error: `QuickBooks did not update the invoice (${why}). Nothing was recorded and the card charge was put back.` }
      }
      const msg = `The QuickBooks invoice update for this ${label} payment was not confirmed (${why}). Nothing was paid. Tap Save as ${label} again — it re-checks the invoice first and won’t record a second payment.`
      if (!(await setState({ qbPaymentStatus: 'uncertain', qbPaymentError: msg }))) return currentPaymentResult(orderId)
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_uncertain', employeeName: actor, note: `${label} ${money(target)} · attempt ${attemptId}: invoice update unconfirmed — ${why}` }).catch(() => {})
      return { ok: false, status: 'uncertain', method, methodLabel: label, amountCents: target, error: msg }
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

  // (6) Write the QuickBooks Payment for this installment — only while THIS worker still holds the lock (a
  // worker stalled past the stale window, whose attempt was taken over, must not write a payment).
  if (!(await setState({ qbPaymentStartedAt: lockAt }))) return currentPaymentResult(orderId)
  try {
    const created = await createRetailPaymentInQB({
      customerId: String(payRaw.CustomerRef?.value ?? ''), invoiceId: String(payRaw.Id), amountCents: target,
      paymentMethodId: mapping.paymentMethodId, depositAccountId: mapping.depositAccountId,
      privateNote: `${paymentTag(v.est.id, attemptId, method)} · Pitt Stop counter payment (${label}) by ${actor ?? 'unknown'}`,
      requestId: attemptId,
    })
    await setState({ qbPaymentId: created.paymentId })
    // (7) Confirm in QuickBooks by THIS payment applied to the invoice; Paid only on a zero balance.
    let after: PaymentRead | null
    try { after = await readPaymentState(v.est) } catch { after = null }
    const mine = after?.summary ? findAttemptPayment(after.payments, { invoiceId: String(after.raw.Id), estimateId: v.est.id, attemptId }) : null
    if (after?.summary && mine && mine.appliedCents === target) {
      const c: Confirmation = { paymentId: mine.paymentId, method, amountCents: target }
      // Fenced on THIS worker's lock: an old worker resuming with a confirmation never overwrites newer state.
      if (!(await markConfirmed(v.est, c, after.summary, actor, 'recorded', lockFence))) return currentPaymentResult(orderId)
      logger.info(APP, 'payment_recorded', { orderId, paymentId: c.paymentId, method, amount: target, balance: after.summary.balanceCents })
      return confirmedResult(v.est, c, after.summary)
    }
    if (after?.summary && mine) {
      const msg = `QuickBooks payment ${mine.paymentId} was recorded for ${money(mine.appliedCents)} instead of ${money(target)} — review it in QuickBooks.`
      if (!(await setState({ qbPaymentStatus: 'review', qbPaymentError: msg, ...balancePatch(after.summary) }))) return currentPaymentResult(orderId)
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_review', employeeName: actor, note: msg }).catch(() => {})
      return { ok: false, status: 'review', paymentId: mine.paymentId, error: msg, balance: view(after.summary) }
    }
    if (after?.summary?.state === 'paid') {
      // Zero balance, but NOT by this payment (it isn't applied to the invoice): never confirmed by the balance —
      // the customer may have paid twice, or our payment sits unapplied. A person reviews it in QuickBooks.
      const msg = `QuickBooks payment ${created.paymentId} (${label} ${money(target)}) was created, but the invoice shows paid by other payments and this one isn’t applied to it — review it in QuickBooks before recording anything else.`
      if (!(await setState({ qbPaymentStatus: 'review', qbPaymentError: msg, ...balancePatch(after.summary) }))) return currentPaymentResult(orderId)
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_review', employeeName: actor, note: msg }).catch(() => {})
      return { ok: false, status: 'review', paymentId: created.paymentId, error: msg, balance: view(after.summary) }
    }
    // Created, but QuickBooks doesn't show it on the invoice yet: unconfirmed (never a second payment — the
    // next check finds it by its attempt id; a retry reuses the requestid).
    const msg = `QuickBooks payment ${created.paymentId} was created, but it isn’t showing on the invoice yet. Tap Check again — it won’t record a second payment.`
    if (!(await setState({ qbPaymentStatus: 'uncertain', qbPaymentError: msg }))) return currentPaymentResult(orderId)
    await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_uncertain', employeeName: actor, note: `${label} ${money(target)} · attempt ${attemptId}: QB payment ${created.paymentId} not yet applied on the invoice` }).catch(() => {})
    return { ok: false, status: 'uncertain', method, methodLabel: label, amountCents: target, paymentId: created.paymentId, error: msg }
  } catch (err) {
    const msg = safeErr(err)
    if (!isAmbiguousWriteError(err)) {
      // QuickBooks definitely rejected it — nothing was recorded; a retry starts a new attempt.
      if (!(await setState({ qbPaymentStatus: 'error', qbPaymentError: msg }))) return currentPaymentResult(orderId)
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_failed', employeeName: actor, note: `${label} ${money(target)}: ${msg}` }).catch(() => {})
      logger.error(APP, 'payment_failed', { orderId, error: msg })
      return { ok: false, status: 'error', block: 'record_failed', error: `QuickBooks did not record the payment: ${msg}` }
    }
    // Ambiguous (timeout / network / 5xx) — maybe recorded. Reconcile now by THIS attempt id; never write again blind.
    if (!(await setState({ qbPaymentStatus: 'uncertain', qbPaymentError: `Unconfirmed: ${msg}` }))) return currentPaymentResult(orderId)
    await logEvent({ serviceOrderId: orderId, eventType: 'invoice_payment_uncertain', employeeName: actor, note: `${label} ${money(target)} · attempt ${attemptId}: ${msg}` }).catch(() => {})
    logger.warn(APP, 'payment_uncertain', { orderId, attemptId, error: msg })
    const check = await readPaymentState(v.est).catch(() => null)
    const uncertainFence: PaymentFence = { statuses: ['uncertain'], requestId: attemptId, startedAt: lockAt }
    const mine = check?.summary ? findAttemptPayment(check.payments, { invoiceId: String(check.raw.Id), estimateId: v.est.id, attemptId }) : null
    if (check?.summary && mine && mine.appliedCents === target) {
      const c: Confirmation = { paymentId: mine.paymentId, method, amountCents: target }
      if (!(await markConfirmed(v.est, c, check.summary, actor, 'recorded', uncertainFence))) return currentPaymentResult(orderId)
      return confirmedResult(v.est, c, check.summary)
    }
    // A zero balance NOT carrying our attempt's payment is NOT proof this attempt landed — our write may have
    // created a payment that isn't applied/visible yet, so a zero balance could hide a duplicate. Stay uncertain;
    // a later Check (by attempt id) confirms it, or a person reconciles it in QuickBooks.
    if (check?.summary) await cacheBalance(v.est.id, check.summary, uncertainFence)
    return { ok: false, status: 'uncertain', method, methodLabel: label, amountCents: target, error: `QuickBooks did not confirm the ${label} payment of ${money(target)}. Nothing is shown as recorded. Tap Check again — retrying it as ${label} for ${money(target)} is safe and will not record a second payment.` }
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
