/**
 * Combine unpaid invoices — two retail Jobs of the SAME confirmed QuickBooks customer each already have their own
 * unpaid, app-created invoice; a manager combines them into ONE, even after both Jobs are completed.
 *
 *   discover (read-only)  the other invoices this Job's invoice could be combined with (QuickBooks-proven customer)
 *   preview  (read-only)  both invoices, each vehicle's services / fees / total, the combined total, which invoice
 *                         stays, exactly what happens to the other, and whether either was emailed
 *   start                 claim (one statement) → void the REPLACED invoice → relink its Job as a member of the
 *                         RETAINED invoice → a reviewed update of the retained invoice (the shared-invoice Sync)
 *   resume / cancel / separate   recovery from any interrupted step
 *
 * Accounting treatment of the replaced invoice: QuickBooks VOID (operation=void, with the reviewed SyncToken) —
 * the transaction keeps its number and history, its amounts become $0, nothing is deleted. Its identity stays on
 * the consolidation row and in both Jobs' event history.
 *
 * Order is void FIRST, then add its charges to the retained invoice. At no moment do both invoices bill the same
 * charges; the worst intermediate state is "the replaced Job's charges are billed nowhere yet", which the durable
 * row records and the panel recovers (finish, or bill separately). Billing actions on BOTH invoices are blocked
 * while a consolidation is unfinished:
 *   - replaced Job: qb_status 'consolidating' (Send / Sync / Record Payment compare-and-sets refuse it), later
 *     'linked' (a pending shared-invoice member — Create refuses it)
 *   - retained Job: a PENDING member row → Send, Record Payment and ordinary Sync refuse (shared_pending), Work
 *     Board removal refuses, and no other Job can link to it (link refuses an invoice under consolidation)
 * Nothing here ever emails. Completion dates, statuses, services and history of both Jobs are never touched.
 */
import crypto from 'node:crypto'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { retailInvoiceConsolidations, retailInvoiceMembers } from '@/apps/workflow/schema'
import { getOrderWithContext, logEvent } from '@/apps/workflow/db'
import { getEstimateRow } from '@/apps/workflow/estimate-db'
import { isDealerOrder } from '@/apps/workflow/fees'
import { extractPsid } from './retail-format'
import { resolveConfirmedRetailCustomer } from './retail-customer'
import { getRetailInvoiceRaw, listRetailInvoicesForCustomer, voidRetailInvoiceInQB, hasVoidMarker, isVoidedInvoice, type RawQBInvoice } from './retail-invoice-write'
import {
  loadJobDraft, jobChargesIssue, buildSharedInvoicePayload, retailInvoiceContact, syncRetailQBInvoice,
  SharedMemberError, type LoadedJob,
} from './retail-invoice-service'
import { previewSharedInvoiceUpdate, type SharedPreview } from './shared-invoice'
import { activeMembershipOf, listActiveMembers, type MemberRow } from './shared-invoice-db'
import { anchorLocalBlock, invoiceMoneyState, linesFromRawInvoice, linesFromPayload, linesFingerprint, sameLines, overwriteUnsafeLineTypes } from './shared-invoice-plan'
import { isAmbiguousWriteError } from './retail-payment'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:invoice-consolidation'
const safeErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`
/* eslint-disable @typescript-eslint/no-explicit-any */
const rowsOf = (res: unknown): any[] => (res as any).rows ?? res
/* eslint-enable @typescript-eslint/no-explicit-any */

export const ACTIVE_CONSOLIDATION = ['prepared', 'voided', 'relinked'] as const
export type ConsolidationRow = typeof retailInvoiceConsolidations.$inferSelect
/** A worker holds a consolidation this long; a crashed worker's lease simply expires. */
const LEASE_SECONDS = 90
/** After an uncertain void, wait this long before allowing Cancel (a slow void could still land). */
const VOID_SETTLE_MS = 2 * 60 * 1000

// ── One side (one Job + its own invoice), fully re-verified from QuickBooks ──────────────────────────────
export interface CombineSide {
  orderId: string
  estimateId: string
  orderNumber: string | null
  vehicle: string
  jobStatus: string
  completedAt: string | null
  invoiceId: string
  invoiceNumber: string | null
  syncToken: string
  linesFingerprint: string
  totalCents: number
  balanceCents: number
  emailed: boolean
  sentAt: string | null
  txnDate: string | null
  qbStatus: string
  qbCustomerId: string
  services: { title: string; cents: number }[]
  workPriceCents: number
  shopSuppliesCents: number
  paymentChargeCents: number
  paymentChargeLabel: string
  taxCents: number
}
type SideCheck = { ok: true; side: CombineSide; raw: RawQBInvoice; job: LoadedJob } | { ok: false; reason: string; qbReadFailed?: boolean }

const vehicleOf = (j: LoadedJob) => j.draft?.vehicle ?? ([j.order?.vehicle.year, j.order?.vehicle.make, j.order?.vehicle.model].filter(Boolean).join(' ') || 'Vehicle')

/** Is this estimate on either side of an unfinished consolidation? */
export async function activeConsolidationFor(estimateId: string): Promise<ConsolidationRow | null> {
  const [r] = await getDb().select().from(retailInvoiceConsolidations)
    .where(and(
      or(eq(retailInvoiceConsolidations.retainedEstimateId, estimateId), eq(retailInvoiceConsolidations.replacedEstimateId, estimateId)),
      inArray(retailInvoiceConsolidations.status, [...ACTIVE_CONSOLIDATION]),
    )).limit(1)
  return r ?? null
}

/**
 * Every rule for one invoice, read fresh (never trusted from the screen). First failure wins:
 * retail Job on the board, its OWN app-created invoice (PSID), settled + unpaid locally, not shared / not already
 * combining, charges ready, not voided, untouched by money in QuickBooks, only line types Pitt Stop can rebuild,
 * lines EXACTLY what Pitt Stop would write for this Job today (so nothing foreign is lost and its total is right),
 * and the Job's email / phone resolves to the invoice's QuickBooks customer (never a name).
 */
async function verifySide(orderId: string): Promise<SideCheck> {
  const job = await loadJobDraft(orderId)
  const order = job.order
  if (!order) return { ok: false, reason: 'Job not found.' }
  if (isDealerOrder(order)) return { ok: false, reason: 'Dealer Jobs are invoiced through Dealer Check-In — never combined.' }
  if (order.status === 'cancelled') return { ok: false, reason: 'This Job was removed.' }
  if (order.status === 'estimate') return { ok: false, reason: 'This is still an estimate.' }
  const est = await getEstimateRow(orderId)
  if (!est?.qbInvoiceId) return { ok: false, reason: 'This Job has no QuickBooks invoice of its own.' }
  const local = anchorLocalBlock({ qbStatus: est.qbStatus, qbPaymentStatus: est.qbPaymentStatus, qbPaymentBalanceState: est.qbPaymentBalanceState, qbSyncError: est.qbSyncError, orderStatus: order.status, isDealer: false })
  if (local) return { ok: false, reason: local }
  if (/sync needed/i.test(est.qbSyncError ?? '')) return { ok: false, reason: 'This invoice has unsynced changes — sync it first.' }
  if (await activeMembershipOf(est.id)) return { ok: false, reason: 'This Job is already on a shared invoice.' }
  if ((await listActiveMembers(est.id)).length) return { ok: false, reason: 'This invoice already bills more than one vehicle.' }
  if (await activeConsolidationFor(est.id)) return { ok: false, reason: 'A combine is already in progress for this invoice.' }
  const issue = await jobChargesIssue(job)
  if (issue) return { ok: false, reason: issue }

  let raw: RawQBInvoice | null
  try { raw = await getRetailInvoiceRaw(est.qbInvoiceId) }
  catch (e) { return { ok: false, qbReadFailed: true, reason: `Couldn’t read invoice #${est.qbInvoiceNumber ?? est.qbInvoiceId} from QuickBooks: ${safeErr(e)}` } }
  if (!raw) return { ok: false, reason: 'The invoice no longer exists in QuickBooks.' }
  if (String(raw.Id) !== String(est.qbInvoiceId) || extractPsid(raw.PrivateNote) !== est.id) return { ok: false, reason: 'This invoice can’t be verified as Pitt Stop’s.' }
  if (isVoidedInvoice(raw)) return { ok: false, reason: 'This invoice is voided or $0.' }
  const money = invoiceMoneyState(raw)
  if (!money.untouched) return { ok: false, reason: money.reason ?? 'Money is applied to this invoice.' }
  const unsafe = overwriteUnsafeLineTypes(raw.Line)
  if (unsafe.length) return { ok: false, reason: `This invoice has lines Pitt Stop can’t rebuild (${unsafe.join(', ')}).` }
  const live = linesFromRawInvoice(raw.Line)
  const liveFp = linesFingerprint(live)
  if (est.qbLinesFingerprint && est.qbLinesFingerprint !== liveFp) return { ok: false, reason: 'This invoice was changed in QuickBooks since Pitt Stop wrote it.' }
  try {
    const { payload } = await buildSharedInvoicePayload({ anchorEstimateId: est.id, anchor: job, members: [] })
    if (!sameLines(live, linesFromPayload(payload.lines))) return { ok: false, reason: 'This invoice doesn’t match its Job’s current charges — sync it first.' }
    if (payload.totalCents !== money.totalCents) return { ok: false, reason: 'This invoice’s total doesn’t match its Job — sync it first.' }
  } catch (e) {
    return { ok: false, reason: `This invoice’s charges couldn’t be verified: ${safeErr(e)}` }
  }
  const customerId = String(raw.CustomerRef?.value ?? '')
  try {
    const ident = await resolveConfirmedRetailCustomer(await retailInvoiceContact(orderId, order.customerName ?? ''))
    if (!ident.qbCustomerId || String(ident.qbCustomerId) !== customerId) return { ok: false, reason: 'This Job’s email / phone doesn’t confirm the invoice’s QuickBooks customer.' }
  } catch (e) {
    return { ok: false, qbReadFailed: true, reason: `Couldn’t confirm the QuickBooks customer: ${safeErr(e)}` }
  }
  const d = job.draft!
  return {
    ok: true, raw, job,
    side: {
      orderId, estimateId: est.id, orderNumber: order.orderNumber ?? null, vehicle: vehicleOf(job), jobStatus: order.status,
      completedAt: order.completedAt ? new Date(order.completedAt).toISOString() : null,
      invoiceId: String(raw.Id), invoiceNumber: raw.DocNumber ?? est.qbInvoiceNumber, syncToken: String(raw.SyncToken), linesFingerprint: liveFp,
      totalCents: money.totalCents, balanceCents: money.balanceCents ?? 0,
      emailed: raw.EmailStatus === 'EmailSent' || est.qbStatus === 'sent', sentAt: est.qbSentAt ? new Date(est.qbSentAt).toISOString() : null,
      txnDate: raw.TxnDate ?? null, qbStatus: est.qbStatus, qbCustomerId: customerId,
      services: d.serviceBreakdown.length ? d.serviceBreakdown : [{ title: d.services.join(', ') || 'Work', cents: d.workPriceCents }],
      workPriceCents: d.workPriceCents, shopSuppliesCents: d.shopSupplies.cents, paymentChargeCents: d.paymentCharge.cents,
      paymentChargeLabel: d.paymentCharge.label, taxCents: d.tax.cents,
    },
  }
}

// ── Discovery ───────────────────────────────────────────────────────────────────────────────────────────
export interface CombineCandidate {
  orderId: string
  orderNumber: string | null
  vehicle: string
  invoiceId: string
  invoiceNumber: string | null
  totalCents: number
  emailed: boolean
  jobStatus: string
  eligible: boolean
  reason: string | null
}
export interface CombineDiscovery {
  ok: boolean
  /** Why THIS Job's invoice can't be combined right now (no lookup of others is made). */
  blocked?: string
  invoiceNumber?: string | null
  candidates: CombineCandidate[]
  error?: string
}

/**
 * READ-ONLY. Other retail Jobs whose OWN invoice belongs to the same QuickBooks customer as this Job's invoice.
 * The customer is proven by QuickBooks (this invoice's CustomerRef, itself confirmed by email / phone) and the
 * other invoice's CustomerRef — never by a name. Each is fully re-verified; ineligible ones show their reason.
 */
export async function findCombineCandidates(orderId: string): Promise<CombineDiscovery> {
  try {
    const self = await verifySide(orderId)
    if (!self.ok) return self.qbReadFailed ? { ok: false, candidates: [], error: self.reason } : { ok: true, blocked: self.reason, candidates: [] }
    const res = await getDb().execute(sql`
      SELECT so.id AS "orderId", je.qb_invoice_id AS "invoiceId"
      FROM job_estimates je JOIN service_orders so ON so.id = je.service_order_id
      WHERE je.qb_invoice_id IS NOT NULL AND so.id <> ${orderId}::uuid AND so.status <> 'cancelled'
        AND lower(coalesce(so.source, '')) NOT IN ('dealer', 'dealer_checkin') AND lower(coalesce(so.service_type, '')) NOT LIKE 'dealer%'`)
    const byInvoice = new Map<string, string>(rowsOf(res).map((r) => [String(r.invoiceId), String(r.orderId)]))
    if (!byInvoice.size) return { ok: true, invoiceNumber: self.side.invoiceNumber, candidates: [] }
    const theirs = (await listRetailInvoicesForCustomer(self.side.qbCustomerId)).filter((inv) => byInvoice.has(String(inv.Id)) && String(inv.CustomerRef?.value ?? '') === self.side.qbCustomerId)
    const candidates: CombineCandidate[] = []
    for (const inv of theirs) {
      const otherId = byInvoice.get(String(inv.Id))!
      const v = await verifySide(otherId)
      if (v.ok) {
        candidates.push({ orderId: otherId, orderNumber: v.side.orderNumber, vehicle: v.side.vehicle, invoiceId: v.side.invoiceId, invoiceNumber: v.side.invoiceNumber, totalCents: v.side.totalCents, emailed: v.side.emailed, jobStatus: v.side.jobStatus, eligible: v.side.qbCustomerId === self.side.qbCustomerId, reason: v.side.qbCustomerId === self.side.qbCustomerId ? null : 'Different QuickBooks customer.' })
      } else {
        const o = await getOrderWithContext(otherId)
        candidates.push({ orderId: otherId, orderNumber: o?.orderNumber ?? null, vehicle: o ? ([o.vehicle.year, o.vehicle.make, o.vehicle.model].filter(Boolean).join(' ') || 'Vehicle') : 'Vehicle', invoiceId: String(inv.Id), invoiceNumber: inv.DocNumber ?? null, totalCents: Math.round(Number(inv.TotalAmt ?? 0) * 100), emailed: inv.EmailStatus === 'EmailSent', jobStatus: o?.status ?? 'unknown', eligible: false, reason: v.reason })
      }
    }
    candidates.sort((x, y) => Number(y.eligible) - Number(x.eligible))
    return { ok: true, invoiceNumber: self.side.invoiceNumber, candidates }
  } catch (e) {
    logger.warn(APP, 'discover_failed', { orderId, error: safeErr(e) })
    return { ok: false, candidates: [], error: 'Couldn’t check QuickBooks for this customer’s other invoices. Nothing was changed — try again.' }
  }
}

// ── Preview (the review screen) ─────────────────────────────────────────────────────────────────────────
export interface CombinePreview {
  ok: boolean
  error?: string
  retained?: CombineSide
  replaced?: CombineSide
  combinedTotalCents?: number
  /** The exact lines the retained invoice will carry (description + amount; headers have no amount). */
  combinedLines?: { description: string; cents: number | null }[]
  emailedAny?: boolean
  /** What happens, in plain words, for the review screen. */
  plan?: string[]
  /** Staff guidance when either invoice was already emailed. */
  emailGuidance?: string | null
}

function pickRetained(a: CombineSide, b: CombineSide): [CombineSide, CombineSide] {
  // The emailed invoice stays (the customer already holds that number); otherwise the older one.
  if (a.emailed !== b.emailed) return a.emailed ? [a, b] : [b, a]
  const ad = a.txnDate ?? '', bd = b.txnDate ?? ''
  if (ad !== bd) return ad < bd ? [a, b] : [b, a]
  return Number(a.invoiceId) <= Number(b.invoiceId) ? [a, b] : [b, a]
}

function emailGuidance(retained: CombineSide, replaced: CombineSide): string | null {
  if (!retained.emailed && !replaced.emailed) return null
  const parts: string[] = []
  if (replaced.emailed) parts.push(`Invoice #${replaced.invoiceNumber} was already emailed. After combining it shows as VOID ($0) in QuickBooks — tell the customer to ignore it and pay only #${retained.invoiceNumber}.`)
  if (retained.emailed) parts.push(`Invoice #${retained.invoiceNumber} was already emailed with only the ${retained.vehicle}. The customer’s copy is out of date until you resend it.`)
  parts.push('Nothing is emailed automatically — use Resend on the combined invoice when you are ready.')
  return parts.join(' ')
}

const fakeMember = (s: CombineSide): MemberRow => ({ memberServiceOrderId: s.orderId, memberEstimateId: s.estimateId, state: 'pending' } as unknown as MemberRow)

async function buildPreview(orderId: string, otherOrderId: string, retainOrderId?: string | null): Promise<CombinePreview & { rawRetained?: RawQBInvoice; rawReplaced?: RawQBInvoice }> {
  if (orderId === otherOrderId) return { ok: false, error: 'Choose a different invoice.' }
  const [x, y] = [await verifySide(orderId), await verifySide(otherOrderId)]
  if (!x.ok) return { ok: false, error: x.reason }
  if (!y.ok) return { ok: false, error: y.reason }
  if (x.side.qbCustomerId !== y.side.qbCustomerId) return { ok: false, error: 'These invoices belong to different QuickBooks customers — they can’t be combined.' }
  let [retained, replaced] = pickRetained(x.side, y.side)
  if (retainOrderId) {
    if (retainOrderId === x.side.orderId) [retained, replaced] = [x.side, y.side]
    else if (retainOrderId === y.side.orderId) [retained, replaced] = [y.side, x.side]
    else return { ok: false, error: 'The invoice to keep must be one of the two.' }
  }
  const retainedCheck = retained.orderId === x.side.orderId ? x : y
  const replacedCheck = retained.orderId === x.side.orderId ? y : x
  let built
  try { built = await buildSharedInvoicePayload({ anchorEstimateId: retained.estimateId, anchor: retainedCheck.job, members: [fakeMember(replaced)] }) }
  catch (e) { return { ok: false, error: e instanceof SharedMemberError ? e.message : `The combined invoice couldn’t be built: ${safeErr(e)}` } }
  const combinedTotalCents = built.payload.totalCents
  if (combinedTotalCents !== retained.totalCents + replaced.totalCents) return { ok: false, error: 'The combined total doesn’t equal the two invoices — nothing can be combined safely.' }
  const plan = [
    `Invoice #${retained.invoiceNumber} stays and is updated to bill both vehicles: ${retained.vehicle} ${usd(retained.totalCents)} + ${replaced.vehicle} ${usd(replaced.totalCents)} = ${usd(combinedTotalCents)}.`,
    `Invoice #${replaced.invoiceNumber} is VOIDED in QuickBooks: it stays in QuickBooks history with its number, its amount becomes $0, and nothing is deleted. The customer is not billed twice.`,
    'Both Jobs keep their status, completion date, services and history. Each Job keeps its own fees; on the combined invoice like fees are shown on one line.',
    'Nothing is emailed.',
  ]
  return {
    ok: true, retained, replaced, combinedTotalCents,
    combinedLines: built.payload.lines.map((l) => ({ description: l.description, cents: l.kind === 'text' ? null : l.amountCents })),
    emailedAny: retained.emailed || replaced.emailed, plan, emailGuidance: emailGuidance(retained, replaced),
    rawRetained: retainedCheck.ok ? retainedCheck.raw : undefined, rawReplaced: replacedCheck.ok ? replacedCheck.raw : undefined,
  }
}

/** READ-ONLY review of combining this Job's invoice with another. Nothing is written anywhere. */
export async function previewCombineInvoices(params: { orderId: string; otherOrderId: string; retainOrderId?: string | null }): Promise<CombinePreview> {
  try {
    const p = await buildPreview(params.orderId, params.otherOrderId, params.retainOrderId)
    delete p.rawRetained; delete p.rawReplaced
    return p
  } catch (e) {
    logger.warn(APP, 'preview_failed', { orderId: params.orderId, error: safeErr(e) })
    return { ok: false, error: `Couldn’t prepare the review: ${safeErr(e)}` }
  }
}

// ── State machine ───────────────────────────────────────────────────────────────────────────────────────
export type CombineBlock =
  | 'not_found' | 'ineligible' | 'stale' | 'confirm_required' | 'busy' | 'qb_read_failed' | 'attention'
  | 'cancelled' | 'not_allowed'
export interface CombineResult {
  ok: boolean
  block?: CombineBlock
  error?: string
  /** Where the consolidation stands now (null when nothing was claimed). */
  status?: ConsolidationRow['status'] | null
  consolidationId?: string
  retainedInvoiceNumber?: string | null
  replacedInvoiceNumber?: string | null
  combinedTotalCents?: number
  alreadyDone?: boolean
}

const result = (op: ConsolidationRow, extra: Partial<CombineResult> = {}): CombineResult => ({
  ok: op.status === 'completed', status: op.status, consolidationId: op.id, retainedInvoiceNumber: op.retainedInvoiceNumber,
  replacedInvoiceNumber: op.replacedInvoiceNumber, combinedTotalCents: op.combinedTotalCents,
  ...(op.attention && op.status !== 'completed' ? { error: op.attention } : {}), ...extra,
})

async function loadOp(id: string): Promise<ConsolidationRow | null> {
  const [r] = await getDb().select().from(retailInvoiceConsolidations).where(eq(retailInvoiceConsolidations.id, id)).limit(1)
  return r ?? null
}

async function bothEvents(op: ConsolidationRow, eventType: string, actor: string | null, retainedNote: string, replacedNote: string) {
  await logEvent({ serviceOrderId: op.retainedServiceOrderId, eventType, employeeName: actor, note: retainedNote }).catch(() => {})
  await logEvent({ serviceOrderId: op.replacedServiceOrderId, eventType, employeeName: actor, note: replacedNote }).catch(() => {})
}

async function setAttention(op: ConsolidationRow, msg: string, actor: string | null): Promise<ConsolidationRow> {
  await getDb().update(retailInvoiceConsolidations).set({ attention: msg, updatedAt: new Date() }).where(eq(retailInvoiceConsolidations.id, op.id))
  await bothEvents(op, 'invoice_combine_attention', actor, `Combine #${op.replacedInvoiceNumber} → #${op.retainedInvoiceNumber}: ${msg}`, `Combine #${op.replacedInvoiceNumber} → #${op.retainedInvoiceNumber}: ${msg}`)
  logger.warn(APP, 'attention', { id: op.id, status: op.status, msg })
  return (await loadOp(op.id))!
}

async function acquireLease(id: string, owner: string): Promise<boolean> {
  const res = await getDb().execute(sql`
    UPDATE retail_invoice_consolidations SET lease_owner = ${owner}, lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
    WHERE id = ${id}::uuid AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = ${owner})
    RETURNING id`)
  return rowsOf(res).length > 0
}
async function releaseLease(id: string, owner: string) {
  await getDb().execute(sql`UPDATE retail_invoice_consolidations SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ${id}::uuid AND lease_owner = ${owner}`).catch(() => {})
}

/**
 * Stop BEFORE any QuickBooks write: the pending member goes away and the replaced Job gets its invoice back in its
 * prior state, in ONE statement fenced on status 'prepared'. Callers must have just read the replaced invoice and
 * seen it NOT voided.
 */
async function cancelPrepared(op: ConsolidationRow, reason: string, actor: string | null): Promise<boolean> {
  const res = await getDb().execute(sql`
    WITH o AS (
      UPDATE retail_invoice_consolidations SET status = 'cancelled', cancelled_at = now(), finished_by = ${actor}, attention = ${reason}, updated_at = now()
      WHERE id = ${op.id}::uuid AND status = 'prepared'
      RETURNING member_id, replaced_estimate_id, replaced_prior_qb_status
    ), m AS (
      UPDATE retail_invoice_members r SET state = 'removed', removed_at = now(), removed_by = ${actor}, removed_reason = ${'Combine cancelled — ' + reason}, updated_at = now()
      FROM o WHERE r.id = o.member_id AND r.state = 'pending'
      RETURNING r.id
    )
    UPDATE job_estimates j SET qb_status = o.replaced_prior_qb_status, updated_at = now()
    FROM o WHERE j.id = o.replaced_estimate_id AND j.qb_status = 'consolidating'
    RETURNING j.id`)
  const done = rowsOf(res).length > 0
  if (done) {
    await bothEvents(op, 'invoice_combine_cancelled', actor,
      `Combine with #${op.replacedInvoiceNumber} cancelled before anything was written to QuickBooks — #${op.retainedInvoiceNumber} unchanged · ${reason}`,
      `Combine into #${op.retainedInvoiceNumber} cancelled before anything was written to QuickBooks — #${op.replacedInvoiceNumber} unchanged and billable again · ${reason}`)
    logger.info(APP, 'cancelled', { id: op.id, reason })
  }
  return done
}

/** QuickBooks shows the replaced invoice voided → record it (idempotent). */
async function markVoided(op: ConsolidationRow, actor: string | null, note: string): Promise<void> {
  const res = await getDb().execute(sql`
    UPDATE retail_invoice_consolidations SET status = 'voided', voided_at = coalesce(voided_at, now()), attention = NULL, updated_at = now()
    WHERE id = ${op.id}::uuid AND status = 'prepared' RETURNING id`)
  if (rowsOf(res).length) {
    await bothEvents(op, 'invoice_combine_voided', actor,
      `Invoice #${op.replacedInvoiceNumber} (${op.replacedInvoiceId}, ${usd(op.replacedTotalCents)}) voided in QuickBooks to combine it into #${op.retainedInvoiceNumber}${note}`,
      `This Job’s invoice #${op.replacedInvoiceNumber} (${op.replacedInvoiceId}, ${usd(op.replacedTotalCents)}) voided in QuickBooks — kept in QuickBooks history at $0; its charges move to #${op.retainedInvoiceNumber}${note}`)
  }
}

/** Step 1 — void the replaced invoice (reviewed SyncToken, never a fresher one). */
async function stepVoid(op: ConsolidationRow, actor: string | null): Promise<CombineResult | null> {
  let rawB: RawQBInvoice | null
  try { rawB = await getRetailInvoiceRaw(op.replacedInvoiceId) }
  catch (e) { const o = await setAttention(op, `Couldn’t read #${op.replacedInvoiceNumber} from QuickBooks (${safeErr(e)}). Both invoices are blocked until this is retried.`, actor); return result(o, { block: 'qb_read_failed' }) }
  // Adopt only QuickBooks' own void marker: a replaced invoice merely zeroed out by hand is NOT treated as voided
  // (it fails the re-checks below and the combine cancels instead).
  if (rawB && extractPsid(rawB.PrivateNote) === op.replacedEstimateId && hasVoidMarker(rawB)) {
    // A void issued earlier landed but its response (or our record of it) was lost — adopt it, never void twice.
    await markVoided(op, actor, op.voidAttemptedAt ? ' (an earlier attempt’s void had landed)' : ' (found already voided in QuickBooks)')
    return null
  }
  if (!rawB) { const o = await setAttention(op, `Invoice #${op.replacedInvoiceNumber} no longer exists in QuickBooks — needs review. Cancel to keep billing separately.`, actor); return result(o, { block: 'attention' }) }

  // Nothing written yet. Both invoices must still be EXACTLY what the manager reviewed.
  const why = await (async (): Promise<string | null> => {
    if (String(rawB.SyncToken) !== op.replacedSyncToken) return `#${op.replacedInvoiceNumber} changed in QuickBooks after it was reviewed (a payment, edit or email).`
    if (extractPsid(rawB.PrivateNote) !== op.replacedEstimateId) return `#${op.replacedInvoiceNumber} can’t be verified as Pitt Stop’s.`
    if (String(rawB.CustomerRef?.value ?? '') !== op.qbCustomerId) return `#${op.replacedInvoiceNumber} now belongs to a different QuickBooks customer.`
    const mB = invoiceMoneyState(rawB)
    if (!mB.untouched) return `#${op.replacedInvoiceNumber}: ${mB.reason}`
    if (linesFingerprint(linesFromRawInvoice(rawB.Line)) !== op.replacedLinesFingerprint) return `#${op.replacedInvoiceNumber}’s lines changed in QuickBooks.`
    let rawA: RawQBInvoice | null
    try { rawA = await getRetailInvoiceRaw(op.retainedInvoiceId) } catch { return 'READ_FAILED' }
    if (!rawA) return `#${op.retainedInvoiceNumber} no longer exists in QuickBooks.`
    if (String(rawA.SyncToken) !== op.retainedSyncToken) return `#${op.retainedInvoiceNumber} changed in QuickBooks after it was reviewed (a payment, edit or email).`
    if (String(rawA.CustomerRef?.value ?? '') !== op.qbCustomerId || extractPsid(rawA.PrivateNote) !== op.retainedEstimateId) return `#${op.retainedInvoiceNumber} can’t be verified.`
    const mA = invoiceMoneyState(rawA)
    if (!mA.untouched) return `#${op.retainedInvoiceNumber}: ${mA.reason}`
    const [a, b] = [await getEstimateRow(op.retainedServiceOrderId), await getEstimateRow(op.replacedServiceOrderId)]
    if (!a || a.qbInvoiceId !== op.retainedInvoiceId || a.qbPaymentStatus !== 'none' || !['created', 'sent'].includes(a.qbStatus)) return `#${op.retainedInvoiceNumber} is being changed or paid in Pitt Stop.`
    if (!b || b.qbStatus !== 'consolidating' || b.qbInvoiceId !== op.replacedInvoiceId || b.qbPaymentStatus !== 'none') return `#${op.replacedInvoiceNumber} is being changed or paid in Pitt Stop.`
    // Never void an invoice that another Job depends on: the replaced invoice must not anchor any shared member
    // or be retained by another unfinished combine (DB backstop: ric_customer_active_uniq).
    const deps = rowsOf(await getDb().execute(sql`
      SELECT 1 FROM retail_invoice_members WHERE anchor_estimate_id = ${op.replacedEstimateId}::uuid AND state <> 'removed'
      UNION ALL
      SELECT 1 FROM retail_invoice_consolidations WHERE retained_estimate_id = ${op.replacedEstimateId}::uuid AND id <> ${op.id}::uuid AND status IN ('prepared', 'voided', 'relinked')
      LIMIT 1`))
    if (deps.length) return `#${op.replacedInvoiceNumber} is now part of another shared invoice or combine.`
    return null
  })()
  if (why === 'READ_FAILED') { const o = await setAttention(op, `Couldn’t read #${op.retainedInvoiceNumber} from QuickBooks. Nothing was written — retry.`, actor); return result(o, { block: 'qb_read_failed' }) }
  if (why) {
    if (op.voidAttemptedAt && Date.now() - new Date(op.voidAttemptedAt).getTime() < VOID_SETTLE_MS) {
      const o = await setAttention(op, `${why} An earlier void attempt is still settling — retry in a couple of minutes.`, actor)
      return result(o, { block: 'busy' })
    }
    await cancelPrepared(op, `${why} Nothing was combined — review again.`, actor)
    return result((await loadOp(op.id))!, { block: 'stale', error: `${why} Nothing was combined — both invoices are unchanged. Review again.` })
  }

  await getDb().update(retailInvoiceConsolidations).set({ voidAttemptedAt: new Date(), updatedAt: new Date() }).where(eq(retailInvoiceConsolidations.id, op.id))
  try {
    const voided = await voidRetailInvoiceInQB(op.replacedInvoiceId, op.replacedSyncToken)
    if (!hasVoidMarker(voided)) {
      const o = await setAttention(op, `QuickBooks answered the void of #${op.replacedInvoiceNumber} but doesn’t show it voided — needs review in QuickBooks.`, actor)
      return result(o, { block: 'attention' })
    }
    await markVoided(op, actor, '')
    return null
  } catch (e) {
    // Did it land anyway? Read back before deciding (a lost response must never lead to a second action).
    const again = await getRetailInvoiceRaw(op.replacedInvoiceId).catch(() => undefined)
    if (again && hasVoidMarker(again)) { await markVoided(op, actor, ' (confirmed by reading QuickBooks after an unclear response)'); return null }
    if (again && !isAmbiguousWriteError(e)) {
      // QuickBooks definitively refused (e.g. the invoice changed: stale SyncToken) — nothing was voided.
      await cancelPrepared(op, `QuickBooks refused to void #${op.replacedInvoiceNumber} (${safeErr(e)}).`, actor)
      return result((await loadOp(op.id))!, { block: 'stale', error: `QuickBooks refused the void (${safeErr(e)}). Nothing was combined — both invoices are unchanged. Review again.` })
    }
    const o = await setAttention(op, `The void of #${op.replacedInvoiceNumber} may or may not have reached QuickBooks (${safeErr(e)}). Both invoices are blocked — retry to check and continue.`, actor)
    return result(o, { block: 'attention' })
  }
}

/** Step 2 — the replaced Job stops pointing at its voided invoice and is a pending member of the retained one. */
async function stepRelink(op: ConsolidationRow, actor: string | null): Promise<CombineResult | null> {
  const res = await getDb().execute(sql`
    WITH j AS (
      UPDATE job_estimates SET qb_invoice_id = NULL, qb_invoice_number = NULL, qb_sync_token = NULL, qb_content_hash = NULL,
             qb_lines_fingerprint = NULL, qb_sync_error = NULL, qb_status = 'linked', updated_at = now()
      WHERE id = ${op.replacedEstimateId}::uuid AND qb_status = 'consolidating' AND qb_invoice_id = ${op.replacedInvoiceId}
      RETURNING id
    )
    UPDATE retail_invoice_consolidations SET status = 'relinked', relinked_at = now(), attention = NULL, updated_at = now()
    WHERE id = ${op.id}::uuid AND status = 'voided' AND EXISTS (SELECT 1 FROM j)
    RETURNING id`)
  if (rowsOf(res).length) {
    await bothEvents(op, 'invoice_combine_relinked', actor,
      `Vehicle from voided #${op.replacedInvoiceNumber} linked to this invoice #${op.retainedInvoiceNumber} — its charges are added next`,
      `Now billed on #${op.retainedInvoiceNumber} (was #${op.replacedInvoiceNumber}, voided) — charges being added`)
    return null
  }
  const now = await loadOp(op.id)
  if (now?.status !== 'voided') return null   // someone else advanced it
  const o = await setAttention(op, 'The replaced Job’s invoice link changed unexpectedly — needs review.', actor)
  return result(o, { block: 'attention' })
}

async function completeOp(op: ConsolidationRow, actor: string | null): Promise<void> {
  const res = await getDb().execute(sql`
    UPDATE retail_invoice_consolidations SET status = 'completed', completed_at = now(), finished_by = ${actor}, attention = NULL, updated_at = now()
    WHERE id = ${op.id}::uuid AND status = 'relinked'
      AND EXISTS (SELECT 1 FROM retail_invoice_members r WHERE r.id = retail_invoice_consolidations.member_id AND r.state = 'applied')
    RETURNING id`)
  if (rowsOf(res).length) {
    const fresh = (await loadOp(op.id))!
    await bothEvents(fresh, 'invoice_combine_completed', actor,
      `Combined: #${op.retainedInvoiceNumber} now bills both vehicles (${usd(op.combinedTotalCents)}); #${op.replacedInvoiceNumber} is voided in QuickBooks. Nothing was emailed.`,
      `Combined into #${op.retainedInvoiceNumber} (${usd(op.combinedTotalCents)} for both vehicles); this Job’s former invoice #${op.replacedInvoiceNumber} is voided. Nothing was emailed.`)
    logger.info(APP, 'completed', { id: op.id })
  }
}

/** Step 3 — the reviewed update of the retained invoice (the shared-invoice Sync, which re-checks everything). */
async function stepUpdate(op: ConsolidationRow, actor: string | null, review: { expectedSyncToken?: string | null; combinedTotalCents?: number | null; confirmSent?: boolean }): Promise<CombineResult | null> {
  const member = op.memberId ? (await getDb().select().from(retailInvoiceMembers).where(eq(retailInvoiceMembers.id, op.memberId)).limit(1))[0] : null
  if (member?.state === 'applied') { await completeOp(op, actor); return null }
  if (!member || member.state !== 'pending') { const o = await setAttention(op, 'The combined vehicle is no longer linked to the invoice — needs review.', actor); return result(o, { block: 'attention' }) }

  const p: SharedPreview = await previewSharedInvoiceUpdate(op.retainedServiceOrderId)
  if (!p.ok) { const o = await setAttention(op, `${p.error ?? 'The combined invoice couldn’t be checked.'} #${op.replacedInvoiceNumber} is already voided — retry, or bill that vehicle separately.`, actor); return result(o, { block: 'attention' }) }
  if (p.blockers?.length) { const o = await setAttention(op, `${p.blockers.join(' ')} #${op.replacedInvoiceNumber} is already voided — fix this and finish, or bill that vehicle separately.`, actor); return result(o, { block: 'attention' }) }
  if ((p.pendingCount ?? 0) !== 1) { const o = await setAttention(op, 'Another vehicle is pending on this invoice — needs review.', actor); return result(o, { block: 'attention' }) }
  const expectedTotal = review.combinedTotalCents ?? op.combinedTotalCents
  if (p.combinedTotalCents !== expectedTotal) {
    const o = await setAttention(op, `The charges changed since the combine was reviewed (${usd(expectedTotal)} → ${usd(p.combinedTotalCents ?? 0)}). Review the combined invoice and finish.`, actor)
    return result(o, { block: 'stale' })
  }
  const token = review.expectedSyncToken ?? op.retainedSyncToken
  if (p.syncToken !== token) {
    const o = await setAttention(op, `#${op.retainedInvoiceNumber} changed in QuickBooks since it was reviewed. Review the combined invoice and finish.`, actor)
    return result(o, { block: 'stale' })
  }
  const r = await syncRetailQBInvoice({ orderId: op.retainedServiceOrderId, actor, confirmSent: op.emailedAcknowledged || !!review.confirmSent, applyPending: true, expectedSyncToken: token })
  if (!r.ok) {
    const o = await setAttention(op, `Updating #${op.retainedInvoiceNumber} didn’t finish: ${r.error ?? r.reviewReason ?? r.block}. #${op.replacedInvoiceNumber} is voided, so its vehicle isn’t billed yet — retry, or bill it separately.`, actor)
    return result(o, { block: r.block === 'stale' ? 'stale' : 'attention' })
  }
  const fresh = (await loadOp(op.id))!
  await completeOp(fresh, actor)
  return null
}

/** Advance a consolidation as far as it safely can (one worker at a time). */
async function drive(id: string, actor: string | null, review: { expectedSyncToken?: string | null; combinedTotalCents?: number | null; confirmSent?: boolean } = {}): Promise<CombineResult> {
  const owner = crypto.randomUUID()
  if (!(await acquireLease(id, owner))) {
    const op = await loadOp(id)
    return op ? result(op, { ok: false, block: 'busy', error: 'This combine is already being processed. Check again in a moment.' }) : { ok: false, block: 'not_found', error: 'Combine not found.' }
  }
  try {
    for (let i = 0; i < 4; i++) {
      const op = await loadOp(id)
      if (!op) return { ok: false, block: 'not_found', error: 'Combine not found.' }
      let stop: CombineResult | null = null
      if (op.status === 'prepared') stop = await stepVoid(op, actor)
      else if (op.status === 'voided') stop = await stepRelink(op, actor)
      else if (op.status === 'relinked') stop = await stepUpdate(op, actor, review)
      else return result(op, op.status === 'cancelled' ? { block: 'cancelled', error: op.attention ?? 'This combine was cancelled.' } : {})
      if (stop) return stop
    }
    return result((await loadOp(id))!)
  } catch (e) {
    const op = await loadOp(id)
    logger.error(APP, 'drive_failed', { id, error: safeErr(e) })
    if (op) { const o = await setAttention(op, `Interrupted: ${safeErr(e)}. Both invoices stay blocked — retry.`, actor).catch(() => op); return result(o, { block: 'attention' }) }
    return { ok: false, block: 'attention', error: safeErr(e) }
  } finally {
    await releaseLease(id, owner)
  }
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Combine, after the manager reviewed it. Re-verifies BOTH invoices fresh, refuses if either changed since review
 * (`expected`), requires `acknowledgeEmailed` when either was emailed, then claims in ONE statement (retained row
 * FOR UPDATE + replaced Job compare-and-set to 'consolidating' + durable row + pending member) and drives the steps.
 * A repeated `requestId` (double tap / retry after a lost response) resumes the same consolidation.
 */
export async function startCombineInvoices(params: {
  retainedOrderId: string; replacedOrderId: string; requestId: string; actor: string | null
  expected: { retainedSyncToken: string; replacedSyncToken: string; combinedTotalCents: number }
  acknowledgeEmailed?: boolean
}): Promise<CombineResult> {
  const { retainedOrderId, replacedOrderId, requestId, actor } = params
  if (!requestId || requestId.length > 80) return { ok: false, block: 'ineligible', error: 'Missing request id.' }
  const [replay] = await getDb().select().from(retailInvoiceConsolidations).where(eq(retailInvoiceConsolidations.requestId, requestId)).limit(1)
  if (replay) {
    if (replay.retainedServiceOrderId !== retainedOrderId || replay.replacedServiceOrderId !== replacedOrderId) return { ok: false, block: 'ineligible', error: 'That request was used for a different combine.' }
    if ((ACTIVE_CONSOLIDATION as readonly string[]).includes(replay.status)) return drive(replay.id, actor)
    return result(replay, { alreadyDone: true })
  }

  const p = await buildPreview(retainedOrderId, replacedOrderId, retainedOrderId)
  if (!p.ok || !p.retained || !p.replaced || !p.rawRetained || !p.rawReplaced) return { ok: false, block: /couldn’t read|couldn’t confirm/i.test(p.error ?? '') ? 'qb_read_failed' : 'ineligible', error: p.error }
  const { retained: A, replaced: B } = p
  if (A.syncToken !== params.expected.retainedSyncToken || B.syncToken !== params.expected.replacedSyncToken || p.combinedTotalCents !== params.expected.combinedTotalCents) {
    return { ok: false, block: 'stale', error: 'An invoice changed after you reviewed it. Nothing was combined — review again.' }
  }
  if (p.emailedAny && !params.acknowledgeEmailed) return { ok: false, block: 'confirm_required', error: p.emailGuidance ?? 'An invoice was already emailed — confirm before combining.' }

  const opId = crypto.randomUUID(), memberId = crypto.randomUUID()
  let claimed: unknown[]
  try {
    const res = await getDb().execute(sql`
      WITH a AS (
        SELECT id FROM job_estimates
        WHERE id = ${A.estimateId}::uuid AND qb_invoice_id = ${A.invoiceId} AND qb_status IN ('created', 'sent')
          AND qb_payment_status = 'none' AND (qb_payment_balance_state IS NULL OR qb_payment_balance_state = 'unpaid')
          AND NOT EXISTS (SELECT 1 FROM retail_invoice_members r WHERE (r.anchor_estimate_id = ${A.estimateId}::uuid OR r.member_estimate_id = ${A.estimateId}::uuid) AND r.state <> 'removed')
        FOR UPDATE
      ), b AS (
        UPDATE job_estimates SET qb_status = 'consolidating', updated_at = now()
        WHERE id = ${B.estimateId}::uuid AND qb_invoice_id = ${B.invoiceId} AND qb_status = ${B.qbStatus}
          AND qb_payment_status = 'none' AND (qb_payment_balance_state IS NULL OR qb_payment_balance_state = 'unpaid')
          AND NOT EXISTS (SELECT 1 FROM retail_invoice_members r WHERE (r.anchor_estimate_id = ${B.estimateId}::uuid OR r.member_estimate_id = ${B.estimateId}::uuid) AND r.state <> 'removed')
          AND EXISTS (SELECT 1 FROM a)
        RETURNING id
      ), fp AS (
        UPDATE job_estimates SET qb_lines_fingerprint = ${A.linesFingerprint}, updated_at = now()
        WHERE id = ${A.estimateId}::uuid AND EXISTS (SELECT 1 FROM b)
        RETURNING id
      ), op AS (
        INSERT INTO retail_invoice_consolidations (
          id, request_id, status, retained_estimate_id, retained_service_order_id, replaced_estimate_id, replaced_service_order_id, member_id,
          qb_customer_id, retained_invoice_id, retained_invoice_number, retained_sync_token, retained_lines_fingerprint, retained_total_cents, retained_emailed,
          replaced_invoice_id, replaced_invoice_number, replaced_sync_token, replaced_lines_fingerprint, replaced_total_cents, replaced_emailed,
          replaced_prior_qb_status, combined_total_cents, emailed_acknowledged, started_by)
        SELECT ${opId}::uuid, ${requestId}, 'prepared', ${A.estimateId}::uuid, ${A.orderId}::uuid, ${B.estimateId}::uuid, ${B.orderId}::uuid, ${memberId}::uuid,
          ${A.qbCustomerId}, ${A.invoiceId}, ${A.invoiceNumber}, ${A.syncToken}, ${A.linesFingerprint}, ${A.totalCents}, ${A.emailed},
          ${B.invoiceId}, ${B.invoiceNumber}, ${B.syncToken}, ${B.linesFingerprint}, ${B.totalCents}, ${B.emailed},
          ${B.qbStatus}, ${p.combinedTotalCents!}, ${!!params.acknowledgeEmailed}, ${actor}
        FROM b
        RETURNING id
      )
      INSERT INTO retail_invoice_members (id, anchor_estimate_id, anchor_service_order_id, member_estimate_id, member_service_order_id, qb_invoice_id, qb_invoice_number, state, link_request_id, linked_by)
      SELECT ${memberId}::uuid, ${A.estimateId}::uuid, ${A.orderId}::uuid, ${B.estimateId}::uuid, ${B.orderId}::uuid, ${A.invoiceId}, ${A.invoiceNumber}, 'pending', ${'combine:' + requestId}, ${actor}
      FROM op
      RETURNING id`)
    claimed = rowsOf(res)
  } catch (e) {
    // Lost a race on a unique index: a double tap with the same request id, or another combine of these Jobs.
    const [again] = await getDb().select().from(retailInvoiceConsolidations).where(eq(retailInvoiceConsolidations.requestId, requestId)).limit(1)
    if (again) return drive(again.id, actor)
    logger.warn(APP, 'claim_failed', { retainedOrderId, replacedOrderId, error: safeErr(e) })
    return { ok: false, block: 'busy', error: 'Another change to these invoices happened at the same time. Nothing was combined — check again.' }
  }
  if (!claimed.length) return { ok: false, block: 'busy', error: 'One of the invoices is being changed, paid, emailed or combined right now. Nothing was combined — check again.' }

  const op = (await loadOp(opId))!
  await bothEvents(op, 'invoice_combine_started', actor,
    `Combine started: #${B.invoiceNumber} (${B.vehicle}, ${usd(B.totalCents)}) into this invoice #${A.invoiceNumber} (${usd(A.totalCents)}) → ${usd(op.combinedTotalCents)}${op.emailedAcknowledged ? ' · emailed invoice acknowledged' : ''} · nothing is emailed`,
    `Combine started: this Job’s invoice #${B.invoiceNumber} (${usd(B.totalCents)}) will be voided and its charges added to #${A.invoiceNumber} (${A.vehicle}) → ${usd(op.combinedTotalCents)} · nothing is emailed`)
  logger.info(APP, 'started', { id: opId, retainedOrderId, replacedOrderId })
  return drive(opId, actor, { expectedSyncToken: A.syncToken, combinedTotalCents: op.combinedTotalCents })
}

// ── Recovery ────────────────────────────────────────────────────────────────────────────────────────────
async function activeOpForOrder(orderId: string): Promise<ConsolidationRow | null> {
  const [r] = await getDb().select().from(retailInvoiceConsolidations)
    .where(and(
      or(eq(retailInvoiceConsolidations.retainedServiceOrderId, orderId), eq(retailInvoiceConsolidations.replacedServiceOrderId, orderId)),
      inArray(retailInvoiceConsolidations.status, [...ACTIVE_CONSOLIDATION]),
    )).limit(1)
  return r ?? null
}

/**
 * Retry / finish an unfinished consolidation. Before the void: re-verifies and continues (or cancels if anything
 * changed). After the void: `expectedSyncToken` + `combinedTotalCents` come from a FRESH review of the combined
 * invoice (previewSharedInvoiceUpdate) whenever the retained invoice changed since the original review.
 */
export async function resumeCombineInvoices(params: { orderId: string; actor: string | null; expectedSyncToken?: string | null; combinedTotalCents?: number | null; confirmSent?: boolean }): Promise<CombineResult> {
  const op = await activeOpForOrder(params.orderId)
  if (!op) return { ok: false, block: 'not_found', error: 'No unfinished combine for this Job.' }
  return drive(op.id, params.actor, { expectedSyncToken: params.expectedSyncToken, combinedTotalCents: params.combinedTotalCents, confirmSent: params.confirmSent })
}

/** Cancel — only while nothing was written to QuickBooks (the replaced invoice is read back and NOT voided). */
export async function cancelCombineInvoices(params: { orderId: string; actor: string | null }): Promise<CombineResult> {
  const op = await activeOpForOrder(params.orderId)
  if (!op) return { ok: false, block: 'not_found', error: 'No unfinished combine for this Job.' }
  if (op.status !== 'prepared') return result(op, { ok: false, block: 'not_allowed', error: `#${op.replacedInvoiceNumber} is already voided — finish combining, or bill that vehicle separately.` })
  const owner = crypto.randomUUID()
  if (!(await acquireLease(op.id, owner))) return result(op, { ok: false, block: 'busy', error: 'This combine is being processed. Check again in a moment.' })
  try {
    const cur = (await loadOp(op.id))!
    if (cur.status !== 'prepared') return result(cur, { ok: false, block: 'not_allowed' })
    if (cur.voidAttemptedAt && Date.now() - new Date(cur.voidAttemptedAt).getTime() < VOID_SETTLE_MS) return result(cur, { ok: false, block: 'busy', error: 'A void request was sent moments ago. Wait a couple of minutes, then retry or cancel.' })
    let raw: RawQBInvoice | null
    try { raw = await getRetailInvoiceRaw(cur.replacedInvoiceId) }
    catch (e) { return result(cur, { ok: false, block: 'qb_read_failed', error: `Couldn’t confirm #${cur.replacedInvoiceNumber} in QuickBooks (${safeErr(e)}). Nothing changed — try again.` }) }
    if (raw && hasVoidMarker(raw)) {
      await markVoided(cur, params.actor, ' (found voided while cancelling)')
      return result((await loadOp(op.id))!, { ok: false, block: 'not_allowed', error: `#${cur.replacedInvoiceNumber} is already voided in QuickBooks — finish combining, or bill that vehicle separately.` })
    }
    await cancelPrepared(cur, 'Cancelled by a manager.', params.actor)
    return result((await loadOp(op.id))!, { ok: true })
  } finally { await releaseLease(op.id, owner) }
}

/**
 * Bill separately — after the void, when the retained invoice can't (or shouldn't) take the charges. Allowed only
 * while QuickBooks shows the retained invoice WITHOUT the replaced Job's charges (its lines are exactly what was
 * reviewed) and no update is in flight. The replaced Job goes back to normal billing (Create gives it a NEW
 * invoice; the voided one is never re-adopted). One statement, fenced on the member still pending.
 */
export async function separateCombineInvoices(params: { orderId: string; actor: string | null }): Promise<CombineResult> {
  const op0 = await activeOpForOrder(params.orderId)
  if (!op0) return { ok: false, block: 'not_found', error: 'No unfinished combine for this Job.' }
  if (op0.status === 'prepared') return result(op0, { ok: false, block: 'not_allowed', error: 'Nothing was voided yet — use Cancel instead.' })
  const owner = crypto.randomUUID()
  if (!(await acquireLease(op0.id, owner))) return result(op0, { ok: false, block: 'busy', error: 'This combine is being processed. Check again in a moment.' })
  try {
    let op = (await loadOp(op0.id))!
    if (op.status === 'voided') { const stop = await stepRelink(op, params.actor); if (stop) return stop; op = (await loadOp(op.id))! }
    if (op.status !== 'relinked') return result(op, { ok: false, block: 'not_allowed' })
    let raw: RawQBInvoice | null
    try { raw = await getRetailInvoiceRaw(op.retainedInvoiceId) }
    catch (e) { return result(op, { ok: false, block: 'qb_read_failed', error: `Couldn’t read #${op.retainedInvoiceNumber} from QuickBooks (${safeErr(e)}). Nothing changed — try again.` }) }
    if (!raw || linesFingerprint(linesFromRawInvoice(raw.Line)) !== op.retainedLinesFingerprint) {
      return result(op, { ok: false, block: 'not_allowed', error: `#${op.retainedInvoiceNumber} no longer shows only its original charges in QuickBooks (the update may have landed). Retry to finish instead.` })
    }
    const res = await getDb().execute(sql`
      WITH a AS (
        SELECT id FROM job_estimates WHERE id = ${op.retainedEstimateId}::uuid AND qb_status NOT IN ('syncing', 'creating', 'sending') FOR UPDATE
      ), o AS (
        UPDATE retail_invoice_consolidations SET status = 'separated', separated_at = now(), finished_by = ${params.actor}, attention = NULL, updated_at = now()
        WHERE id = ${op.id}::uuid AND status = 'relinked' AND EXISTS (SELECT 1 FROM a)
          AND EXISTS (SELECT 1 FROM retail_invoice_members r WHERE r.id = ${op.memberId}::uuid AND r.state = 'pending')
        RETURNING member_id, replaced_estimate_id
      ), m AS (
        UPDATE retail_invoice_members r SET state = 'removed', removed_at = now(), removed_by = ${params.actor}, removed_reason = 'Combine stopped — billed separately', updated_at = now()
        FROM o WHERE r.id = o.member_id AND r.state = 'pending'
        RETURNING r.id
      )
      UPDATE job_estimates j SET qb_status = 'none', qb_sync_error = NULL, updated_at = now()
      FROM o WHERE j.id = o.replaced_estimate_id AND j.qb_status = 'linked' AND j.qb_invoice_id IS NULL
      RETURNING j.id`)
    if (!rowsOf(res).length) return result((await loadOp(op.id))!, { ok: false, block: 'busy', error: 'The invoice is being updated right now. Check again in a moment.' })
    // A failed or interrupted update may have left the retained invoice's Sync in 'error'; its lines are verified
    // unchanged above, so it is settled again at its prior state.
    await getDb().execute(sql`UPDATE job_estimates SET qb_status = CASE WHEN qb_sent_at IS NOT NULL THEN 'sent' ELSE 'created' END, updated_at = now()
      WHERE id = ${op.retainedEstimateId}::uuid AND qb_status = 'error' AND qb_lines_fingerprint = ${op.retainedLinesFingerprint}`)
    await bothEvents(op, 'invoice_combine_separated', params.actor,
      `Combine stopped: #${op.retainedInvoiceNumber} keeps only its own charges. The other vehicle is billed separately (its old invoice #${op.replacedInvoiceNumber} stays voided).`,
      `Combine stopped: back to separate billing. Old invoice #${op.replacedInvoiceNumber} stays voided in QuickBooks — create a NEW invoice for this Job.`)
    return result((await loadOp(op.id))!, { ok: true })
  } finally { await releaseLease(op0.id, owner) }
}

// ── Read model ──────────────────────────────────────────────────────────────────────────────────────────
export interface CombineState {
  id: string
  status: ConsolidationRow['status']
  role: 'retained' | 'replaced'
  active: boolean
  retained: { orderId: string; invoiceNumber: string | null; totalCents: number; emailed: boolean }
  replaced: { orderId: string; invoiceNumber: string | null; invoiceId: string; totalCents: number; emailed: boolean }
  combinedTotalCents: number
  attention: string | null
  /** What a manager can do now. */
  canResume: boolean
  canCancel: boolean
  canSeparate: boolean
  /** Plain-words state for staff. */
  summary: string
  emailGuidance: string | null
  updatedAt: string
}

function summaryOf(op: ConsolidationRow): string {
  switch (op.status) {
    case 'prepared': return `Combining #${op.replacedInvoiceNumber} into #${op.retainedInvoiceNumber}: nothing has been voided yet. Both invoices are blocked until this finishes or is cancelled.`
    case 'voided':
    case 'relinked': return `#${op.replacedInvoiceNumber} is voided; its charges still need to be added to #${op.retainedInvoiceNumber}. Until then that vehicle isn’t billed — finish, or bill it separately.`
    case 'completed': return `#${op.retainedInvoiceNumber} bills both vehicles (${usd(op.combinedTotalCents)}). #${op.replacedInvoiceNumber} is voided in QuickBooks.`
    case 'cancelled': return `Combine cancelled before anything changed in QuickBooks — #${op.retainedInvoiceNumber} and #${op.replacedInvoiceNumber} are both unchanged.`
    case 'separated': return `Combine stopped after #${op.replacedInvoiceNumber} was voided — that vehicle is billed separately on a new invoice.`
    default: return op.status
  }
}

/** The latest consolidation touching this Job (unfinished first). Completing a finished-in-the-background update is reconciled here. */
export async function loadCombineState(orderId: string, actor: string | null = null): Promise<CombineState | null> {
  let op = await activeOpForOrder(orderId)
  if (!op) {
    const [last] = await getDb().select().from(retailInvoiceConsolidations)
      .where(or(eq(retailInvoiceConsolidations.retainedServiceOrderId, orderId), eq(retailInvoiceConsolidations.replacedServiceOrderId, orderId)))
      .orderBy(desc(retailInvoiceConsolidations.createdAt)).limit(1)
    if (!last || last.status === 'cancelled') return null
    op = last
  }
  if (op.status === 'relinked') {
    // The shared-invoice "Update invoice" may have applied the member from the other screen — record completion.
    await completeOp(op, actor)
    op = (await loadOp(op.id))!
  }
  const active = (ACTIVE_CONSOLIDATION as readonly string[]).includes(op.status)
  const g = op.retainedEmailed || op.replacedEmailed
    ? [op.replacedEmailed ? `#${op.replacedInvoiceNumber} was emailed earlier — tell the customer it is void ($0) and to pay only #${op.retainedInvoiceNumber}.` : '',
       op.retainedEmailed ? `#${op.retainedInvoiceNumber} was emailed before it included both vehicles — resend it when ready.` : '',
       'Nothing is emailed automatically.'].filter(Boolean).join(' ')
    : null
  return {
    id: op.id, status: op.status, role: op.retainedServiceOrderId === orderId ? 'retained' : 'replaced', active,
    retained: { orderId: op.retainedServiceOrderId, invoiceNumber: op.retainedInvoiceNumber, totalCents: op.retainedTotalCents, emailed: op.retainedEmailed },
    replaced: { orderId: op.replacedServiceOrderId, invoiceNumber: op.replacedInvoiceNumber, invoiceId: op.replacedInvoiceId, totalCents: op.replacedTotalCents, emailed: op.replacedEmailed },
    combinedTotalCents: op.combinedTotalCents, attention: active ? op.attention : null,
    canResume: active, canCancel: op.status === 'prepared', canSeparate: op.status === 'voided' || op.status === 'relinked',
    summary: summaryOf(op), emailGuidance: g, updatedAt: new Date(op.updatedAt).toISOString(),
  }
}
