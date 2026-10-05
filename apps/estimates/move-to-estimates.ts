/**
 * Coordinated "Move to Estimates": take an accidental Work Board entry back to the Estimates board,
 * keeping the SAME record (customer, vehicle, services, prices, notes, photos, history) while
 * correcting its QuickBooks invoice when one exists. Retail-only — dealer vehicles never move.
 *
 * This mirrors the fail-closed, idempotent shape of apps/workflow/order-removal.ts, and reuses the
 * SAME QuickBooks "brain" (apps/workflow/removal-plan.ts) and writers (apps/quickbooks/invoice-removal):
 *   1. gate eligibility with a SPECIFIC, plain-language reason (retail, waiting, not started/finished,
 *      no technician assigned).
 *   2. if a QB invoice is linked → read its live state and decide:
 *        · payment activity / ambiguous identity → REFUSE (QB untouched, job stays on the board).
 *        · already SENT to the customer           → REFUSE (never silently undo a customer-facing doc).
 *        · a clean, unsent standalone invoice      → VOID it (so the estimate becomes a fresh draft).
 *   3. ONLY on confirmed QB success (or no invoice) → run the atomic move (moveBoardOrderToEstimates),
 *      which preserves everything and writes the 'moved_to_estimates' audit event.
 *   4. append audit events at every step; a crash between void and move recovers on retry via the
 *      append-only event ledger (we never void twice, never move without the void confirmed).
 *
 * The actual QB mutation only happens in the deployed app (production QuickBooks is not reachable
 * from a local shell); locally and in tests the QB reads/writes are mocked.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { isDealerOrder, orderSourceKind } from '@/apps/workflow/fees'
import {
  decideQbRemovalPlan, planBlocksRemoval, planRequiresQbWrite,
  type RemovalLinkage, type QbInvoiceSnapshot,
} from '@/apps/workflow/removal-plan'
import { readRetailInvoiceSnapshot, voidInvoice } from '@/apps/quickbooks/invoice-removal'
import { moveBoardOrderToEstimates } from './move-from-board'
import { logger } from '@/platform/logger'

const APP = 'estimates:move-to-estimates'

/** The one event that proves a prior attempt already corrected QuickBooks (idempotency recovery). */
const QB_VOIDED_EVENT = 'move_qb_invoice_voided'

export type MoveBlockCode =
  | 'not_found' | 'already_moved' | 'dealer' | 'not_retail' | 'cancelled' | 'delivered'
  | 'started' | 'completed' | 'not_waiting' | 'assigned'
  | 'invoice_paid' | 'invoice_sent' | 'invoice_ambiguous' | 'qb_unreachable' | 'qb_write_failed'

/** The job row (+ linked estimate/QB fields) this flow reasons over. Raw-SQL shaped, so tests can
 *  use a minimal schema exactly like move-from-board.test.ts. */
interface MoveOrderRow {
  id:              string
  status:          string
  source:          string | null
  serviceType:     string | null
  customerName:    string | null
  startedAt:       unknown
  completedAt:     unknown
  cancelledAt:     unknown
  deliveredAt:     unknown
  vehicle:         string
  assignmentCount: number
  estimateId:      string | null
  qbInvoiceId:     string | null
  qbInvoiceNumber: string | null
  qbStatus:        string | null
  qbSentAt:        unknown
}

async function readMoveOrder(orderId: string): Promise<MoveOrderRow | null> {
  const db = getDb()
  const { rows } = await db.execute(sql`
    SELECT so.id, so.status, so.source, so.service_type AS "serviceType", so.customer_name AS "customerName",
      so.started_at AS "startedAt", so.completed_at AS "completedAt",
      so.cancelled_at AS "cancelledAt", so.delivered_at AS "deliveredAt",
      trim(concat_ws(' ', v.year, v.make, v.model)) AS vehicle,
      (SELECT count(*) FROM service_order_assignments a WHERE a.service_order_id = so.id)::int AS "assignmentCount",
      e.id AS "estimateId", e.qb_invoice_id AS "qbInvoiceId", e.qb_invoice_number AS "qbInvoiceNumber",
      e.qb_status AS "qbStatus", e.qb_sent_at AS "qbSentAt"
    FROM service_orders so
    JOIN vehicles v ON v.id = so.vehicle_id
    LEFT JOIN job_estimates e ON e.service_order_id = so.id
    WHERE so.id = ${orderId}::uuid
    LIMIT 1
  `)
  return (rows[0] as unknown as MoveOrderRow) ?? null
}

/**
 * Pure eligibility for the NON-invoice gates, with a specific plain-language reason. The invoice
 * gates (paid / sent / ambiguous) are decided separately against the live QuickBooks snapshot, and
 * the atomic move SQL remains the final hard authority. Order of checks is deliberate — most
 * fundamental first (dealer/retail) so the message a manager sees is the real blocker.
 */
export function moveBaseEligibility(order: MoveOrderRow): { ok: true } | { ok: false; code: MoveBlockCode; error: string } {
  const kind = orderSourceKind({ source: order.source, serviceType: order.serviceType })
  if (isDealerOrder({ source: order.source, serviceType: order.serviceType }) || kind === 'dealer')
    return { ok: false, code: 'dealer', error: 'Dealer vehicles stay on the Work Board — they can’t move to Estimates.' }
  if (kind !== 'retail')
    return { ok: false, code: 'not_retail', error: 'Only retail jobs can move to Estimates.' }
  if (order.status === 'cancelled' || order.cancelledAt)
    return { ok: false, code: 'cancelled', error: 'This job was removed from the Work Board, so there’s nothing to move.' }
  if (order.status === 'delivered' || order.deliveredAt)
    return { ok: false, code: 'delivered', error: 'This job was already delivered, so it can’t move to Estimates.' }
  if (order.startedAt)
    return { ok: false, code: 'started', error: 'Work has already started on this vehicle, so it can’t move to Estimates. Reopen or remove it instead.' }
  if (order.completedAt)
    return { ok: false, code: 'completed', error: 'This job is already finished, so it can’t move to Estimates.' }
  if (order.status !== 'arrived')
    return { ok: false, code: 'not_waiting', error: `Only vehicles waiting on the Work Board can move to Estimates (this one is ${order.status}).` }
  if (order.assignmentCount > 0)
    return { ok: false, code: 'assigned', error: 'A technician is assigned to this vehicle. Unassign it before moving to Estimates.' }
  return { ok: true }
}

/** Was the linked invoice already presented to the customer? Either our own send-state or QB's. We
 *  never auto-void a customer-facing invoice — the manager must handle it in QuickBooks first. */
function invoiceWasSent(order: Pick<MoveOrderRow, 'qbStatus' | 'qbSentAt'>, snap: QbInvoiceSnapshot): boolean {
  const sentLocally = order.qbStatus === 'sent' || order.qbSentAt != null
  const sentInQb = (snap.emailStatus ?? '').toLowerCase() === 'emailsent'
  return sentLocally || sentInQb
}

const RETAIL_LINK = (): RemovalLinkage => ({ isDealer: false, hasQbLink: true, stockToken: null, storedLineId: null })

// ── Read-only preview (UI: show customer + vehicle + what will happen before the manager confirms) ──
export interface MovePreview {
  eligible:        boolean
  code?:           MoveBlockCode
  reason?:         string        // plain-language, specific — shown when !eligible
  customer:        string
  vehicle:         string
  invoiceNumber:   string | null
  willVoidInvoice: boolean       // an unsent standalone invoice will be voided as part of the move
  qbUnreachable?:  boolean       // couldn't verify the invoice; the POST re-checks and fails closed
}

export async function planMoveToEstimates(orderId: string): Promise<{ ok: boolean; error?: string; preview?: MovePreview }> {
  const order = await readMoveOrder(orderId)
  if (!order) return { ok: false, error: 'Job not found.' }
  const base = { customer: order.customerName?.trim() || 'Customer', vehicle: order.vehicle || 'Vehicle', invoiceNumber: order.qbInvoiceNumber, willVoidInvoice: false }
  if (order.status === 'estimate')
    return { ok: true, preview: { ...base, eligible: false, code: 'already_moved', reason: 'This job is already in Estimates.' } }

  const gate = moveBaseEligibility(order)
  if (!gate.ok) return { ok: true, preview: { ...base, eligible: false, code: gate.code, reason: gate.error } }

  if (!order.qbInvoiceId) return { ok: true, preview: { ...base, eligible: true } }

  let snap: QbInvoiceSnapshot
  try { snap = await readRetailInvoiceSnapshot(order.qbInvoiceId, order.estimateId ?? '') }
  catch (err) {
    logger.warn(APP, 'preview.qb_unreachable', { orderId, error: String(err) })
    return { ok: true, preview: { ...base, eligible: true, qbUnreachable: true } }
  }
  const plan = decideQbRemovalPlan(RETAIL_LINK(), snap)
  const invoiceNumber = snap.invoiceNumber ?? order.qbInvoiceNumber
  if (plan.kind === 'blocked_paid')
    return { ok: true, preview: { ...base, invoiceNumber, eligible: false, code: 'invoice_paid', reason: `Invoice #${invoiceNumber ?? '?'} has payment activity and can’t be undone automatically. Review it in QuickBooks.` } }
  if (plan.kind === 'ambiguous')
    return { ok: true, preview: { ...base, invoiceNumber, eligible: false, code: 'invoice_ambiguous', reason: 'This job couldn’t be matched to an exact QuickBooks invoice, so nothing will be changed. Review it in QuickBooks.' } }
  if (plan.kind === 'void_standalone' && invoiceWasSent(order, snap))
    return { ok: true, preview: { ...base, invoiceNumber, eligible: false, code: 'invoice_sent', reason: `Invoice #${invoiceNumber ?? '?'} was already sent to the customer. Void or cancel it in QuickBooks before moving this job to Estimates.` } }
  if (plan.kind === 'void_standalone')
    return { ok: true, preview: { ...base, invoiceNumber, eligible: true, willVoidInvoice: true } }
  // idempotent_qb_done (already gone/voided) — move freely, nothing left to void.
  return { ok: true, preview: { ...base, invoiceNumber, eligible: true } }
}

// ── Execute ─────────────────────────────────────────────────────────────────────────────────────
export interface MoveResult {
  ok:            boolean
  alreadyMoved?: boolean
  block?:        MoveBlockCode | 'not_eligible'
  code?:         MoveBlockCode
  error?:        string
  qbAction?:     'none' | 'invoice_voided' | 'already_done'
  invoiceNumber?: string | null
}

async function logMoveEvent(orderId: string, eventType: string, actor: string | null, note?: string, oldStatus?: string, newStatus?: string) {
  await getDb().execute(sql`
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, old_status, new_status, note)
    VALUES (${orderId}::uuid, ${eventType}, ${actor}, ${oldStatus ?? null}, ${newStatus ?? null}, ${note ?? null})
  `)
}

async function orderHasVoidEvent(orderId: string): Promise<boolean> {
  const { rows } = await getDb().execute(sql`
    SELECT 1 FROM service_order_events WHERE service_order_id = ${orderId}::uuid AND event_type = ${QB_VOIDED_EVENT} LIMIT 1`)
  return rows.length > 0
}

/** Clear the now-dead QB link so the estimate becomes a clean draft and the atomic move guard
 *  (which refuses any job that still carries a QB invoice) passes. Idempotent. */
async function clearEstimateQbLink(orderId: string, actor: string | null) {
  await getDb().execute(sql`
    UPDATE job_estimates SET qb_invoice_id = NULL, qb_invoice_number = NULL, qb_status = 'none',
      qb_sync_token = NULL, qb_sent_at = NULL, updated_at = now(), updated_by = ${actor}
    WHERE service_order_id = ${orderId}::uuid`)
}

/**
 * Perform the coordinated move. Manager/admin authorization is enforced by the API route; this
 * function assumes an authorized actor and focuses on the atomic QB-then-move sequence.
 */
export async function executeMoveToEstimates(params: { orderId: string; actor: string | null }): Promise<MoveResult> {
  const { orderId, actor } = params
  const order = await readMoveOrder(orderId)
  if (!order) return { ok: false, block: 'not_found', code: 'not_found', error: 'Job not found.' }

  // Idempotency #1 — already in Estimates. Return the successful terminal state, touch nothing.
  if (order.status === 'estimate') return { ok: true, alreadyMoved: true, qbAction: 'already_done' }

  const gate = moveBaseEligibility(order)
  if (!gate.ok) return { ok: false, block: gate.code, code: gate.code, error: gate.error }

  await logMoveEvent(orderId, 'move_to_estimates_requested', actor, undefined, order.status)

  // Idempotency #2 — a prior attempt already voided the invoice but didn't finish the move (e.g.
  // crashed between steps). Skip QB entirely and complete the move.
  if (await orderHasVoidEvent(orderId)) {
    await clearEstimateQbLink(orderId, actor)
    await runMove(orderId, actor)
    return { ok: true, qbAction: 'already_done', invoiceNumber: order.qbInvoiceNumber }
  }

  // No linked invoice → straightforward move (preserves everything; writes 'moved_to_estimates').
  if (!order.qbInvoiceId) {
    const moved = await runMove(orderId, actor)
    if (!moved.ok) return moved
    return { ok: true, qbAction: 'none' }
  }

  // 1. Read the live QB invoice state.
  let snap: QbInvoiceSnapshot
  try { snap = await readRetailInvoiceSnapshot(order.qbInvoiceId, order.estimateId ?? '') }
  catch (err) {
    await logMoveEvent(orderId, 'move_to_estimates_failed', actor, `QuickBooks unreachable: ${String(err)}`)
    return { ok: false, block: 'qb_unreachable', code: 'qb_unreachable', error: 'Could not reach QuickBooks to verify the invoice. Nothing was changed — please try again.' }
  }
  const plan = decideQbRemovalPlan(RETAIL_LINK(), snap)
  const invoiceNumber = snap.invoiceNumber ?? order.qbInvoiceNumber

  // 2. Fail closed — never touch QB, never move (avoid an inconsistent split state).
  if (plan.kind === 'blocked_paid') {
    await logMoveEvent(orderId, 'move_to_estimates_failed', actor, `blocked: payment activity on invoice #${invoiceNumber ?? '?'}`)
    return { ok: false, block: 'invoice_paid', code: 'invoice_paid', invoiceNumber, error: `Invoice #${invoiceNumber ?? '?'} has payment activity and can’t be undone automatically. Review it in QuickBooks.` }
  }
  if (plan.kind === 'ambiguous') {
    await logMoveEvent(orderId, 'move_to_estimates_failed', actor, `blocked: ambiguous QB linkage (${plan.reason})`)
    return { ok: false, block: 'invoice_ambiguous', code: 'invoice_ambiguous', error: 'This job couldn’t be matched to an exact QuickBooks invoice, so nothing was changed. Review it in QuickBooks.' }
  }
  if (plan.kind === 'void_standalone' && invoiceWasSent(order, snap)) {
    await logMoveEvent(orderId, 'move_to_estimates_failed', actor, `blocked: invoice #${invoiceNumber ?? '?'} already sent to customer`)
    return { ok: false, block: 'invoice_sent', code: 'invoice_sent', invoiceNumber, error: `Invoice #${invoiceNumber ?? '?'} was already sent to the customer. Void or cancel it in QuickBooks before moving this job to Estimates.` }
  }

  // 3. Void the clean, unsent standalone invoice (idempotent writer). Only mutate when required.
  let qbAction: MoveResult['qbAction'] = 'none'
  if (planRequiresQbWrite(plan)) {
    const w = await voidInvoice({ invoiceId: snap.invoiceId })
    if (!w.ok) {
      await logMoveEvent(orderId, 'move_to_estimates_failed', actor, `QB void failed on #${invoiceNumber ?? '?'}: ${w.error}`)
      return { ok: false, block: 'qb_write_failed', code: 'qb_write_failed', invoiceNumber, error: 'Could not void the QuickBooks invoice. Nothing was changed — please try again.' }
    }
    qbAction = 'invoice_voided'
    await logMoveEvent(orderId, QB_VOIDED_EVENT, actor, `#${invoiceNumber ?? '?'}${w.idempotent ? ' (already voided)' : ''} · was $${((w.totalCentsBefore ?? 0) / 100).toFixed(2)}`)
  } else if (plan.kind === 'idempotent_qb_done') {
    qbAction = 'already_done'
  }

  // 4. Clear the dead link and perform the atomic move — only reached when QB is confirmed in the
  //    desired state (every block/failure path returned above).
  await clearEstimateQbLink(orderId, actor)
  const moved = await runMove(orderId, actor)
  if (!moved.ok) return { ...moved, invoiceNumber } // QB corrected; retry recovers via the ledger
  logger.info(APP, 'moved', { orderId, qbAction, invoiceNumber })
  return { ok: true, qbAction, invoiceNumber }
}

/** Run the atomic move SQL, translating its guard failure into the generic retry message. */
async function runMove(orderId: string, actor: string | null): Promise<MoveResult> {
  try {
    await moveBoardOrderToEstimates(orderId, actor ?? 'Manager')
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error && err.message.startsWith('Only retail jobs')
      ? err.message : 'Unable to move this job. Please refresh and try again.'
    await logMoveEvent(orderId, 'move_to_estimates_failed', actor, `atomic move rejected: ${String(err)}`).catch(() => {})
    return { ok: false, block: 'not_eligible', error: message }
  }
}
