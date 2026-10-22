/**
 * Shared retail invoice — orchestration. A later retail Job for the SAME confirmed QuickBooks customer can join
 * that customer's existing unpaid, app-created retail invoice instead of getting its own.
 *
 *   discover  (read-only)  after intake / from the Invoice Draft: eligible open invoices for this Job's customer
 *   link                   the Job becomes a PENDING member — nothing is written to QuickBooks, nothing is sent
 *   unlink                 a still-pending member goes back to normal separate billing
 *   preview   (read-only)  the vehicle breakdown + combined total the manager reviews before updating
 *   update                 a reviewed Sync of the SAME invoice that adds the pending Jobs' charges (never sends)
 *
 * Safety (each re-checked at link AND at update, never trusted from the screen):
 *   - retail only — a dealer Job is refused before any lookup; a dealer invoice is never a candidate
 *   - customer identity proven by email / phone (never a name) and equal to the invoice's QuickBooks CustomerRef
 *   - the invoice is Pitt Stop's own (PSID), untouched by money (balance === total, no payment / credit), not
 *     voided / deleted, and its lines are exactly what Pitt Stop wrote (so nothing foreign is overwritten)
 *   - a Job that already has its own QuickBooks invoice is refused: two invoices are never merged automatically
 *   - link / unlink / update serialize on the anchor row (FOR UPDATE + the Sync compare-and-set lock)
 *   - every membership change is an append-only service_order_events entry on BOTH Jobs
 * Job completion never touches any of this.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { getOrderWithContext, logEvent } from '@/apps/workflow/db'
import { getEstimateRow, getOrCreateEstimate } from '@/apps/workflow/estimate-db'
import { isDealerOrder } from '@/apps/workflow/fees'
import { extractPsid } from './retail-format'
import { resolveConfirmedRetailCustomer } from './retail-customer'
import { getRetailInvoiceRaw, listRetailInvoicesForCustomer, findRetailInvoiceByPsid, type RawQBInvoice } from './retail-invoice-write'
import {
  loadJobDraft, jobChargesIssue, buildSharedInvoicePayload, sharedMemberCustomerMismatch, retailInvoiceContact,
  syncRetailQBInvoice, SharedMemberError, type RetailSyncResolution, type LoadedJob,
} from './retail-invoice-service'
import { activeMembershipOf, listActiveMembers, type MemberRow } from './shared-invoice-db'
import { anchorLocalBlock, memberLocalBlock, invoiceMoneyState, linesFromRawInvoice, linesFromPayload, linesFingerprint, sameLines } from './shared-invoice-plan'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:shared-invoice'
const safeErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const vehicleName = (o: { vehicle: { year?: string | null; make?: string | null; model?: string | null; vin?: string | null } } | null) =>
  o ? ([o.vehicle.year, o.vehicle.make, o.vehicle.model].filter(Boolean).join(' ') || o.vehicle.vin || 'Vehicle') : 'Vehicle'

// ── Discovery ─────────────────────────────────────────────────────────────────────────────────────
export interface SharedCandidate {
  anchorOrderId: string
  anchorEstimateId: string
  invoiceId: string
  invoiceNumber: string | null
  /** The QuickBooks version this offer was built from — link refuses if the invoice changed since. */
  syncToken: string
  /** Vehicles already on (or pending for) this invoice, anchor first. */
  vehicles: string[]
  totalCents: number
  balanceCents: number
  emailed: boolean
  sentAt: string | null
  txnDate: string | null
  eligible: boolean
  /** Why it can't take this vehicle (shown, never offered as an action). */
  reason: string | null
}
export type DiscoverySkip = 'dealer' | 'cancelled' | 'estimate' | 'has_invoice' | 'already_linked' | 'busy' | 'no_confirmed_customer' | 'not_found'
export interface DiscoveryResult {
  ok: boolean
  /** The lookup was deliberately not run (dealer Job, already invoiced, no email/phone identity, …). */
  skipped?: DiscoverySkip
  message?: string
  customerName?: string | null
  vehicle?: string | null
  candidates: SharedCandidate[]
  /** The lookup itself failed (QuickBooks unreachable) — the saved Job is untouched; retry from its invoice. */
  error?: string
}

interface MemberCtx { orderId: string; job: LoadedJob; estimateId: string | null; customerId: string; customerName: string | null }

/** Resolve the new Job's eligibility + confirmed QuickBooks customer, or the reason no lookup is made. */
async function memberContext(orderId: string): Promise<{ ok: true; ctx: MemberCtx } | { ok: false; result: DiscoveryResult }> {
  const job = await loadJobDraft(orderId)
  const order = job.order
  if (!order) return { ok: false, result: { ok: true, skipped: 'not_found', message: 'Job not found.', candidates: [] } }
  // Dealer isolation: refused before ANY customer or QuickBooks lookup.
  const dealer = isDealerOrder(order)
  const est = dealer ? null : await getEstimateRow(orderId)
  const membership = est ? await activeMembershipOf(est.id) : null
  const block = memberLocalBlock({ isDealer: dealer, orderStatus: order.status, qbInvoiceId: est?.qbInvoiceId ?? null, qbStatus: est?.qbStatus ?? 'none', activeMembership: !!membership })
  if (block) return { ok: false, result: { ok: true, skipped: block.code as DiscoverySkip, message: block.message, candidates: [] } }
  const contact = await retailInvoiceContact(orderId, order.customerName ?? '')
  const ident = await resolveConfirmedRetailCustomer(contact)
  if (!ident.qbCustomerId) {
    return { ok: false, result: { ok: true, skipped: 'no_confirmed_customer', message: 'No email or phone links this customer to a single QuickBooks customer, so no open invoice is offered (names alone are never matched).', customerName: contact.name, candidates: [] } }
  }
  return { ok: true, ctx: { orderId, job, estimateId: est?.id ?? null, customerId: String(ident.qbCustomerId), customerName: contact.name } }
}

/** Pitt Stop's own open retail invoices (anchor rows) other than this Job — local filter before any QB read. */
async function localAnchorRows(excludeOrderId: string): Promise<Array<{ estimateId: string; orderId: string; invoiceId: string; invoiceNumber: string | null; qbStatus: string; qbPaymentStatus: string; qbPaymentBalanceState: string | null; qbSyncError: string | null; qbSentAt: Date | null; qbLinesFingerprint: string | null; orderStatus: string; source: string | null; serviceType: string | null }>> {
  const res = await getDb().execute(sql`
    SELECT je.id AS "estimateId", so.id AS "orderId", je.qb_invoice_id AS "invoiceId", je.qb_invoice_number AS "invoiceNumber",
           je.qb_status AS "qbStatus", je.qb_payment_status AS "qbPaymentStatus", je.qb_payment_balance_state AS "qbPaymentBalanceState",
           je.qb_sync_error AS "qbSyncError", je.qb_sent_at AS "qbSentAt", je.qb_lines_fingerprint AS "qbLinesFingerprint",
           so.status AS "orderStatus", so.source AS "source", so.service_type AS "serviceType"
    FROM job_estimates je JOIN service_orders so ON so.id = je.service_order_id
    WHERE je.qb_invoice_id IS NOT NULL AND so.id <> ${excludeOrderId}::uuid AND so.status <> 'cancelled'
      AND lower(coalesce(so.source, '')) NOT IN ('dealer', 'dealer_checkin') AND lower(coalesce(so.service_type, '')) NOT LIKE 'dealer%'`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res as any).rows ?? res
}
type AnchorRow = Awaited<ReturnType<typeof localAnchorRows>>[number]

/**
 * Is this app-created invoice able to take one more Job right now? Every rule, in order; first failure wins.
 * Reconstruction: QuickBooks' lines must be EXACTLY what Pitt Stop would write today for the Jobs already on it
 * (anchor + applied members) — proves the original charges are Pitt Stop's and nothing foreign gets overwritten.
 */
async function assessCandidate(ctx: MemberCtx, a: AnchorRow, raw: RawQBInvoice): Promise<SharedCandidate> {
  const members = await listActiveMembers(a.estimateId)
  const anchorJob = await loadJobDraft(a.orderId)
  const memberJobs = await Promise.all(members.map((m) => getOrderWithContext(m.memberServiceOrderId)))
  const money = invoiceMoneyState(raw)
  const base: SharedCandidate = {
    anchorOrderId: a.orderId, anchorEstimateId: a.estimateId, invoiceId: String(raw.Id), invoiceNumber: raw.DocNumber ?? a.invoiceNumber,
    syncToken: String(raw.SyncToken), vehicles: [vehicleName(anchorJob.order), ...memberJobs.map((o) => vehicleName(o))],
    totalCents: money.totalCents, balanceCents: money.balanceCents ?? 0,
    emailed: raw.EmailStatus === 'EmailSent' || a.qbStatus === 'sent',
    sentAt: a.qbSentAt ? new Date(a.qbSentAt).toISOString() : null, txnDate: raw.TxnDate ?? null,
    eligible: false, reason: null,
  }
  const refuse = (reason: string): SharedCandidate => ({ ...base, reason })
  if (extractPsid(raw.PrivateNote) !== a.estimateId) return refuse('This invoice can’t be verified as Pitt Stop’s.')
  if (String(raw.CustomerRef?.value ?? '') !== ctx.customerId) return refuse('This invoice belongs to a different QuickBooks customer.')
  const local = anchorLocalBlock({ qbStatus: a.qbStatus, qbPaymentStatus: a.qbPaymentStatus, qbPaymentBalanceState: a.qbPaymentBalanceState, qbSyncError: a.qbSyncError, orderStatus: a.orderStatus, isDealer: !anchorJob.order || isDealerOrder(anchorJob.order) })
  if (local) return refuse(local)
  if (!money.untouched) return refuse(money.reason ?? 'Money is applied to this invoice.')
  if (/sync needed/i.test(a.qbSyncError ?? '')) return refuse('This invoice has unsynced changes — open its Job and sync it first.')
  try {
    const applied = members.filter((m) => m.state === 'applied')
    const { payload } = await buildSharedInvoicePayload({ anchorEstimateId: a.estimateId, anchor: anchorJob, members: applied })
    if (!sameLines(linesFromRawInvoice(raw.Line), linesFromPayload(payload.lines))) return refuse('This invoice was changed in QuickBooks, so its charges can’t be safely rebuilt — add this vehicle by hand in QuickBooks or keep it separate.')
    if (payload.totalCents !== money.totalCents) return refuse('This invoice’s total no longer matches its Jobs — sync it first.')
  } catch (e) {
    return refuse(e instanceof SharedMemberError ? e.message : 'This invoice’s charges couldn’t be verified right now.')
  }
  return { ...base, eligible: true }
}

/**
 * READ-ONLY. The open invoices this Job could join. Never writes — not to Pitt Stop, not to QuickBooks. Dealer
 * Jobs (and anything else ineligible) return `skipped` before any lookup. A QuickBooks failure returns `error`.
 */
export async function findSharedInvoiceCandidates(orderId: string): Promise<DiscoveryResult> {
  try {
    const mc = await memberContext(orderId)
    if (!mc.ok) return mc.result
    const { ctx } = mc
    const head = { ok: true, customerName: ctx.customerName, vehicle: ctx.job.draft?.vehicle ?? null }
    const anchors = await localAnchorRows(orderId)
    if (anchors.length === 0) return { ...head, candidates: [] }   // common case: no QuickBooks call at all
    const byInvoice = new Map(anchors.map((a) => [String(a.invoiceId), a]))
    const invoices = (await listRetailInvoicesForCustomer(ctx.customerId)).filter((inv) => byInvoice.has(String(inv.Id)))
    const candidates: SharedCandidate[] = []
    for (const raw of invoices) candidates.push(await assessCandidate(ctx, byInvoice.get(String(raw.Id))!, raw))
    candidates.sort((x, y) => Number(y.eligible) - Number(x.eligible))
    return { ...head, candidates }
  } catch (e) {
    logger.warn(APP, 'discover_failed', { orderId, error: safeErr(e) })
    return { ok: false, candidates: [], error: 'Couldn’t check QuickBooks for open invoices. The Job is saved — retry from its invoice.' }
  }
}

// ── Link ──────────────────────────────────────────────────────────────────────────────────────────
export interface LinkResult {
  ok: boolean
  block?: 'not_found' | 'dealer' | 'ineligible' | 'stale' | 'has_invoice' | 'already_linked' | 'busy' | 'qb_read_failed' | 'customer'
  alreadyLinked?: boolean
  invoiceNumber?: string | null
  anchorOrderId?: string
  error?: string
}

/**
 * Link this Job to the chosen invoice as a PENDING member. Re-checks EVERY rule fresh (never trusts the offer),
 * refuses if the invoice changed since it was shown (`expectedSyncToken`), then writes membership + the member's
 * 'linked' status + the anchor's verified line fingerprint in ONE statement. Idempotent: a repeat for the same
 * invoice returns ok/alreadyLinked; a race loses on rim_member_active_uniq or the compare-and-set.
 * No QuickBooks write, no send.
 */
export async function linkToSharedInvoice(params: { orderId: string; anchorOrderId: string; invoiceId: string; expectedSyncToken?: string | null; requestId?: string | null; actor: string | null }): Promise<LinkResult> {
  const { orderId, anchorOrderId, invoiceId, actor } = params
  if (orderId === anchorOrderId) return { ok: false, block: 'ineligible', error: 'A Job can’t be added to its own invoice.' }
  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, block: 'not_found', error: 'Job not found.' }
  if (isDealerOrder(order)) return { ok: false, block: 'dealer', error: 'Dealer Jobs are invoiced through Dealer Check-In.' }

  // Idempotent replay (double tap / retry after a lost response).
  const est0 = await getEstimateRow(orderId)
  const existing = est0 ? await activeMembershipOf(est0.id) : null
  if (existing) {
    if (existing.anchorServiceOrderId === anchorOrderId && existing.qbInvoiceId === invoiceId) return { ok: true, alreadyLinked: true, invoiceNumber: existing.qbInvoiceNumber, anchorOrderId }
    return { ok: false, block: 'already_linked', error: `This Job is already on shared invoice #${existing.qbInvoiceNumber ?? existing.qbInvoiceId}.` }
  }

  let mc
  try { mc = await memberContext(orderId) }
  catch (e) { return { ok: false, block: 'qb_read_failed', error: `Couldn’t check QuickBooks: ${safeErr(e)}` } }
  if (!mc.ok) return { ok: false, block: mc.result.skipped === 'has_invoice' ? 'has_invoice' : mc.result.skipped === 'no_confirmed_customer' ? 'customer' : mc.result.skipped === 'dealer' ? 'dealer' : 'ineligible', error: mc.result.message }
  const { ctx } = mc

  const anchor = (await localAnchorRows(orderId)).find((a) => a.orderId === anchorOrderId && String(a.invoiceId) === String(invoiceId))
  if (!anchor) return { ok: false, block: 'ineligible', error: 'That invoice is no longer an open Pitt Stop retail invoice.' }
  let raw: RawQBInvoice | null
  try { raw = await getRetailInvoiceRaw(invoiceId) }
  catch (e) { return { ok: false, block: 'qb_read_failed', error: `Couldn’t read the invoice from QuickBooks: ${safeErr(e)}` } }
  if (!raw) return { ok: false, block: 'ineligible', error: 'That invoice no longer exists in QuickBooks.' }
  if (params.expectedSyncToken != null && String(raw.SyncToken) !== String(params.expectedSyncToken)) {
    return { ok: false, block: 'stale', error: 'That invoice changed in QuickBooks after it was shown. Nothing was linked — check again.' }
  }
  const assessed = await assessCandidate(ctx, anchor, raw)
  if (!assessed.eligible) return { ok: false, block: 'ineligible', error: assessed.reason ?? 'That invoice can’t take another vehicle.' }

  // A Job whose earlier Create failed might still have an invoice in QuickBooks (lost response): never merge.
  if (est0?.qbStatus === 'error') {
    const orphan = await findRetailInvoiceByPsid(ctx.customerId, est0.id).catch(() => undefined)
    if (orphan === undefined) return { ok: false, block: 'qb_read_failed', error: 'Couldn’t confirm this Job has no invoice of its own in QuickBooks. Try again.' }
    if (orphan) return { ok: false, block: 'has_invoice', error: `This Job already has its own QuickBooks invoice #${orphan.invoiceNumber ?? orphan.invoiceId}. Two invoices are never merged automatically — reconcile them in QuickBooks.` }
  }

  const est = est0 ?? await getOrCreateEstimate(orderId, actor)
  const fp = linesFingerprint(linesFromRawInvoice(raw.Line))
  const number = raw.DocNumber ?? anchor.invoiceNumber
  let inserted: Array<{ id: string }>
  try {
    const res = await getDb().execute(sql`
      WITH anchor AS (
        SELECT a.id FROM job_estimates a
        WHERE a.id = ${anchor.estimateId}::uuid AND a.qb_invoice_id = ${invoiceId} AND a.qb_status IN ('created', 'sent')
          AND a.qb_payment_status = 'none' AND (a.qb_payment_balance_state IS NULL OR a.qb_payment_balance_state = 'unpaid')
        FOR UPDATE
      ), lock AS (
        UPDATE job_estimates m SET qb_status = 'linked', qb_sync_error = NULL, updated_at = now()
        WHERE m.id = ${est.id}::uuid AND m.qb_invoice_id IS NULL AND m.qb_status IN ('none', 'error') AND EXISTS (SELECT 1 FROM anchor)
        RETURNING m.id
      ), fp AS (
        UPDATE job_estimates a SET qb_lines_fingerprint = ${fp}, updated_at = now()
        WHERE a.id = ${anchor.estimateId}::uuid AND EXISTS (SELECT 1 FROM lock)
        RETURNING a.id
      )
      INSERT INTO retail_invoice_members (anchor_estimate_id, anchor_service_order_id, member_estimate_id, member_service_order_id, qb_invoice_id, qb_invoice_number, state, link_request_id, linked_by)
      SELECT ${anchor.estimateId}::uuid, ${anchorOrderId}::uuid, lock.id, ${orderId}::uuid, ${invoiceId}, ${number}, 'pending', ${params.requestId ?? null}, ${actor}
      FROM lock
      RETURNING id`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inserted = (res as any).rows ?? res
  } catch (e) {
    // Lost a race on rim_member_active_uniq → report the winner's outcome (idempotent replay).
    const m = await activeMembershipOf(est.id)
    if (m?.anchorServiceOrderId === anchorOrderId && m.qbInvoiceId === invoiceId) return { ok: true, alreadyLinked: true, invoiceNumber: m.qbInvoiceNumber, anchorOrderId }
    logger.warn(APP, 'link_failed', { orderId, error: safeErr(e) })
    return { ok: false, block: 'busy', error: 'Couldn’t link — another change happened at the same time. Check again.' }
  }
  if (!inserted.length) {
    const m = await activeMembershipOf(est.id)
    if (m?.anchorServiceOrderId === anchorOrderId && m.qbInvoiceId === invoiceId) return { ok: true, alreadyLinked: true, invoiceNumber: m.qbInvoiceNumber, anchorOrderId }
    const fresh = await getEstimateRow(orderId)
    if (fresh?.qbInvoiceId || fresh?.qbStatus === 'creating') return { ok: false, block: 'has_invoice', error: 'An invoice was just created for this Job — it can’t join another invoice.' }
    return { ok: false, block: 'busy', error: 'That invoice changed (payment, update or send in progress). Nothing was linked — check again.' }
  }

  const vehicle = vehicleName(order)
  await logEvent({ serviceOrderId: orderId, eventType: 'shared_invoice_linked', employeeName: actor, note: `Added to ${ctx.customerName ?? 'customer'}'s open invoice #${number} (${invoiceId}) with ${assessed.vehicles.join(', ')} — charges pending manager review; nothing written to QuickBooks, nothing sent` }).catch(() => {})
  await logEvent({ serviceOrderId: anchorOrderId, eventType: 'shared_invoice_member_added', employeeName: actor, note: `${vehicle} linked to invoice #${number} (${invoiceId}) — charges pending review; Send / Record Payment wait until the invoice is updated` }).catch(() => {})
  logger.info(APP, 'linked', { orderId, anchorOrderId, invoiceId })
  return { ok: true, invoiceNumber: number, anchorOrderId }
}

// ── Unlink (Keep separate, later) ─────────────────────────────────────────────────────────────────
export interface UnlinkResult { ok: boolean; block?: 'not_linked' | 'applied' | 'busy'; error?: string }

/**
 * Put a still-PENDING member back on normal separate billing (it may then Create its own invoice). One statement,
 * fenced on the anchor's qb_status being a POSITIVELY settled `created` / `sent` AND NOT carrying a "Needs review"
 * sync error (FOR UPDATE). This refuses an in-flight write (`syncing`/`creating`/`sending`), a NON-settled `error`
 * state (a reviewed update whose QuickBooks write landed but whose local finalization failed ends in `error` with
 * the member still `pending`, so its charges are already on the invoice — unlinking then would let the vehicle be
 * billed twice), and any "Needs review" state (the invoice must be resolved first).
 * Once a member's charges are on the invoice (applied) it can't be unlinked here — that is a QuickBooks correction.
 */
export async function unlinkSharedInvoiceMember(params: { orderId: string; actor: string | null; reason?: string | null }): Promise<UnlinkResult> {
  const { orderId, actor } = params
  const est = await getEstimateRow(orderId)
  const m = est ? await activeMembershipOf(est.id) : null
  if (!m) return { ok: true }   // already separate (idempotent)
  if (m.state === 'applied') return { ok: false, block: 'applied', error: `This vehicle’s charges are already on invoice #${m.qbInvoiceNumber ?? m.qbInvoiceId}. Removing them is a correction to make in QuickBooks.` }
  const res = await getDb().execute(sql`
    WITH anchor AS (
      SELECT a.id FROM job_estimates a
      WHERE a.id = ${m.anchorEstimateId}::uuid AND a.qb_status IN ('created', 'sent')
        AND (a.qb_sync_error IS NULL OR a.qb_sync_error NOT ILIKE 'needs review%')
      FOR UPDATE
    ), rm AS (
      UPDATE retail_invoice_members r SET state = 'removed', removed_at = now(), removed_by = ${actor}, removed_reason = ${params.reason ?? 'Kept separate'}, updated_at = now()
      WHERE r.id = ${m.id}::uuid AND r.state = 'pending' AND EXISTS (SELECT 1 FROM anchor)
      RETURNING r.member_estimate_id
    )
    UPDATE job_estimates j SET qb_status = 'none', updated_at = now()
    FROM rm WHERE j.id = rm.member_estimate_id AND j.qb_status = 'linked'
    RETURNING j.id`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (res as any).rows ?? res
  if (!rows.length) {
    const again = await activeMembershipOf(m.memberEstimateId)
    if (!again) return { ok: true }
    if (again.state === 'applied') return { ok: false, block: 'applied', error: 'This vehicle’s charges were just added to the invoice.' }
    // Still pending, but the fence rejected a non-settled anchor. Say whether it's mid-write (retry) or whether its
    // last update failed / needs review — the latter must be resolved first, because a failed-but-landed update may
    // already have put these charges on the invoice (unlinking would then let the vehicle bill twice).
    const anchor = await getEstimateRow(m.anchorServiceOrderId)
    const st = anchor?.qbStatus ?? ''
    if (['syncing', 'creating', 'sending'].includes(st)) return { ok: false, block: 'busy', error: 'The invoice is being updated right now. Try again in a moment.' }
    return { ok: false, block: 'busy', error: 'This invoice isn’t settled — its last update failed or it needs review. Resolve the invoice first (its charges may already be on it), then keep this vehicle separate.' }
  }
  const order = await getOrderWithContext(orderId)
  await logEvent({ serviceOrderId: orderId, eventType: 'shared_invoice_unlinked', employeeName: actor, note: `Removed from shared invoice #${m.qbInvoiceNumber} (${m.qbInvoiceId}) before its charges were added — back to separate billing${params.reason ? ` · ${params.reason}` : ''}` }).catch(() => {})
  await logEvent({ serviceOrderId: m.anchorServiceOrderId, eventType: 'shared_invoice_member_removed', employeeName: actor, note: `${vehicleName(order)} no longer linked to invoice #${m.qbInvoiceNumber} (its charges were never added)` }).catch(() => {})
  return { ok: true }
}

// ── Read model (Invoice Draft / Completion Summary on BOTH Jobs) ──────────────────────────────────
export interface SharedInvoiceState {
  role: 'anchor' | 'member'
  invoiceId: string
  invoiceNumber: string | null
  anchorOrderId: string
  /** This Job's own membership state (member role only). */
  memberState: 'pending' | 'applied' | null
  vehicles: Array<{ orderId: string; orderNumber: string | null; vehicle: string; state: 'anchor' | 'pending' | 'applied'; appliedTotalCents: number | null }>
  pendingCount: number
  /** The invoice's billing state (from the anchor's QuickBooks link). */
  invoice: { status: string; sent: boolean; sentAt: string | null; syncNeeded: boolean; needsReview: boolean; paymentStatus: string; balanceState: string | null }
}

/** Shared-invoice state for a Job (either side), or null when it is billed on its own. DB reads only. */
export async function loadSharedInvoiceState(orderId: string): Promise<SharedInvoiceState | null> {
  const est = await getEstimateRow(orderId)
  if (!est) return null
  let anchorOrderId: string, memberState: SharedInvoiceState['memberState'] = null, role: SharedInvoiceState['role']
  if (est.qbInvoiceId) { anchorOrderId = orderId; role = 'anchor' }
  else {
    const m = await activeMembershipOf(est.id)
    if (!m) return null
    anchorOrderId = m.anchorServiceOrderId; memberState = m.state as 'pending' | 'applied'; role = 'member'
  }
  const anchorRow = role === 'anchor' ? est : await getEstimateRow(anchorOrderId)
  if (!anchorRow?.qbInvoiceId) return null
  const members = await listActiveMembers(anchorRow.id)
  if (role === 'anchor' && members.length === 0) return null
  const anchorOrder = await getOrderWithContext(anchorRow.serviceOrderId)
  const memberOrders = await Promise.all(members.map((m) => getOrderWithContext(m.memberServiceOrderId)))
  const err = anchorRow.qbSyncError ?? ''
  const needsReview = /^needs review/i.test(err)
  return {
    role, memberState,
    invoiceId: anchorRow.qbInvoiceId, invoiceNumber: anchorRow.qbInvoiceNumber, anchorOrderId: anchorRow.serviceOrderId,
    vehicles: [
      { orderId: anchorRow.serviceOrderId, orderNumber: anchorOrder?.orderNumber ?? null, vehicle: vehicleName(anchorOrder), state: 'anchor', appliedTotalCents: null },
      ...members.map((m, i) => ({ orderId: m.memberServiceOrderId, orderNumber: memberOrders[i]?.orderNumber ?? null, vehicle: vehicleName(memberOrders[i]), state: m.state as 'pending' | 'applied', appliedTotalCents: m.appliedTotalCents })),
    ],
    pendingCount: members.filter((m) => m.state === 'pending').length,
    invoice: {
      status: anchorRow.qbStatus, sent: anchorRow.qbStatus === 'sent', sentAt: anchorRow.qbSentAt ? new Date(anchorRow.qbSentAt).toISOString() : null,
      syncNeeded: /sync needed/i.test(err) && !needsReview, needsReview,
      paymentStatus: anchorRow.qbPaymentStatus, balanceState: anchorRow.qbPaymentBalanceState,
    },
  }
}

// ── Review (preview) + update ─────────────────────────────────────────────────────────────────────
export interface SharedPreviewPart {
  orderId: string
  vehicle: string
  state: 'anchor' | 'pending' | 'applied'
  services: { title: string; cents: number }[]
  workPriceCents: number
  shopSuppliesCents: number
  paymentChargeCents: number
  paymentChargeLabel: string
  taxCents: number
  totalCents: number
  /** What must be fixed on this Job before the invoice can be updated (null = ready). */
  issue: string | null
}
export interface SharedPreview {
  ok: boolean
  anchorOrderId?: string
  invoiceId?: string
  invoiceNumber?: string | null
  /** Pass back on update — refused if the invoice changes in between. */
  syncToken?: string
  emailed?: boolean
  sentAt?: string | null
  qbTotalCents?: number
  qbBalanceCents?: number | null
  parts?: SharedPreviewPart[]
  combinedTotalCents?: number
  pendingCount?: number
  /** Reasons the update can't run now (shown; the Update button stays disabled). */
  blockers?: string[]
  error?: string
}

async function anchorOrderIdFor(orderId: string): Promise<{ anchorOrderId: string; anchorEstimateId: string } | null> {
  const est = await getEstimateRow(orderId)
  if (!est) return null
  if (est.qbInvoiceId) return { anchorOrderId: orderId, anchorEstimateId: est.id }
  const m = await activeMembershipOf(est.id)
  return m ? { anchorOrderId: m.anchorServiceOrderId, anchorEstimateId: m.anchorEstimateId } : null
}

function previewPart(job: LoadedJob, state: SharedPreviewPart['state'], issue: string | null): SharedPreviewPart {
  const d = job.draft
  return {
    orderId: job.orderId, vehicle: d?.vehicle ?? vehicleName(job.order), state,
    services: d?.serviceBreakdown.length ? d.serviceBreakdown : (d ? [{ title: d.services.join(', ') || 'Work', cents: d.workPriceCents }] : []),
    workPriceCents: d?.workPriceCents ?? 0, shopSuppliesCents: d?.shopSupplies.cents ?? 0,
    paymentChargeCents: d?.paymentCharge.cents ?? 0, paymentChargeLabel: d?.paymentCharge.label ?? 'Card charge',
    taxCents: d?.tax.cents ?? 0, totalCents: d?.totalCents ?? 0, issue,
  }
}

/**
 * READ-ONLY review for "Update shared invoice": every vehicle's own breakdown (its work, fees, tax, total), the
 * combined total, the invoice's current QuickBooks total / balance / emailed state, and anything blocking the
 * update. Callable from either Job. Nothing is written.
 */
export async function previewSharedInvoiceUpdate(orderId: string): Promise<SharedPreview> {
  const at = await anchorOrderIdFor(orderId)
  if (!at) return { ok: false, error: 'This Job isn’t on a shared invoice.' }
  const anchorEst = await getEstimateRow(at.anchorOrderId)
  if (!anchorEst?.qbInvoiceId) return { ok: false, error: 'The shared invoice is no longer linked.' }
  const members = await listActiveMembers(at.anchorEstimateId)
  const anchorJob = await loadJobDraft(at.anchorOrderId)
  const blockers: string[] = []
  const parts: SharedPreviewPart[] = [previewPart(anchorJob, 'anchor', await jobChargesIssue(anchorJob))]
  for (const m of members) {
    const j = await loadJobDraft(m.memberServiceOrderId)
    parts.push(previewPart(j, m.state as 'pending' | 'applied', await jobChargesIssue(j)))
  }
  for (const p of parts) if (p.issue) blockers.push(`${p.vehicle}: ${p.issue}`)
  const combinedTotalCents = parts.reduce((t, p) => t + p.totalCents, 0)

  let raw: RawQBInvoice | null
  try { raw = await getRetailInvoiceRaw(anchorEst.qbInvoiceId) }
  catch (e) { return { ok: false, error: `Couldn’t read the invoice from QuickBooks: ${safeErr(e)}` } }
  if (!raw) return { ok: false, error: 'The invoice no longer exists in QuickBooks — needs review.' }
  if (extractPsid(raw.PrivateNote) !== anchorEst.id) blockers.push('The invoice can’t be verified as Pitt Stop’s.')
  const money = invoiceMoneyState(raw)
  if (!money.untouched) blockers.push(`${money.reason ?? 'Money is applied to this invoice.'} Linked charges can’t be added — keep the pending vehicle separate.`)
  if (anchorEst.qbPaymentStatus !== 'none') blockers.push('A payment was recorded or started on this invoice.')
  if (/^needs review/i.test(anchorEst.qbSyncError ?? '')) blockers.push(`The invoice needs review: ${anchorEst.qbSyncError}`)
  if (['creating', 'syncing', 'sending'].includes(anchorEst.qbStatus)) blockers.push('The invoice is being changed right now.')
  const liveLinesFingerprint = linesFingerprint(linesFromRawInvoice(raw.Line))
  const mm = await sharedMemberCustomerMismatch(members, String(raw.CustomerRef?.value ?? '')).catch(() => ({ orderId: '', message: 'Couldn’t confirm every vehicle’s customer.' }))
  if (mm) blockers.push(mm.message)
  if (!blockers.length) {
    try {
      const { payload } = await buildSharedInvoicePayload({ anchorEstimateId: anchorEst.id, anchor: anchorJob, members })
      // A lost response can leave QuickBooks at the exact reviewed target while local members remain pending.
      // Match that complete target before allowing recovery through the review screen; unrelated edits still block.
      const landedPendingUpdate = anchorEst.qbStatus === 'error' && members.some((m) => m.state === 'pending')
        && liveLinesFingerprint === linesFingerprint(linesFromPayload(payload.lines))
        && money.totalCents === payload.totalCents
      if (anchorEst.qbLinesFingerprint && liveLinesFingerprint !== anchorEst.qbLinesFingerprint && !landedPendingUpdate) {
        blockers.push('The invoice was changed in QuickBooks since Pitt Stop last updated it — review it there first.')
      }
    }
    catch (e) { blockers.push(e instanceof SharedMemberError ? e.message : `The combined invoice couldn’t be built: ${safeErr(e)}`) }
  }
  return {
    ok: true, anchorOrderId: at.anchorOrderId, invoiceId: anchorEst.qbInvoiceId, invoiceNumber: raw.DocNumber ?? anchorEst.qbInvoiceNumber,
    syncToken: String(raw.SyncToken), emailed: raw.EmailStatus === 'EmailSent' || anchorEst.qbStatus === 'sent',
    sentAt: anchorEst.qbSentAt ? new Date(anchorEst.qbSentAt).toISOString() : null,
    qbTotalCents: money.totalCents, qbBalanceCents: money.balanceCents,
    parts, combinedTotalCents, pendingCount: members.filter((m) => m.state === 'pending').length, blockers,
  }
}

/**
 * The reviewed "Update invoice": a Sync of the SAME QuickBooks invoice that also writes the pending Jobs' charges
 * (syncRetailQBInvoice with applyPending). Every safety check runs again inside, under the Sync lock. Never sends.
 * `confirmSent` is required when the invoice was already emailed; `expectedSyncToken` = the reviewed version.
 */
export async function updateSharedInvoice(params: { orderId: string; actor: string | null; confirmSent?: boolean; expectedSyncToken?: string | null }): Promise<RetailSyncResolution & { anchorOrderId?: string }> {
  const at = await anchorOrderIdFor(params.orderId)
  if (!at) return { ok: false, block: 'no_invoice', error: 'This Job isn’t on a shared invoice.' }
  const members: MemberRow[] = await listActiveMembers(at.anchorEstimateId)
  if (!members.length) return { ok: false, block: 'no_invoice', error: 'No other vehicles are linked to this invoice.' }
  if (params.expectedSyncToken == null) return { ok: false, block: 'stale', error: 'Review the combined invoice before updating it.' }
  const r = await syncRetailQBInvoice({ orderId: at.anchorOrderId, actor: params.actor, confirmSent: params.confirmSent, applyPending: true, expectedSyncToken: params.expectedSyncToken })
  logger.info(APP, 'update', { orderId: params.orderId, anchorOrderId: at.anchorOrderId, ok: r.ok, block: r.block, applied: r.appliedOrderIds?.length ?? 0 })
  return { ...r, anchorOrderId: at.anchorOrderId }
}
