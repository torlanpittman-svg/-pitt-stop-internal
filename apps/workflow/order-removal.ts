/**
 * Coordinated Work Board removal: soft-cancel the Job AND correct its linked QuickBooks record in
 * one scoped, fail-closed, idempotent flow. This is the ONLY place managers can touch a QB invoice
 * as part of an accidental-check-in correction — there is no general invoice-edit surface.
 *
 * Ordering (atomic-by-construction, per the product spec):
 *   1. prove linkage + read live QB state → decide the plan (removal-plan.ts)
 *   2. if the plan blocks (paid / ambiguous) → refuse; QB untouched, Job stays on the board
 *   3. perform the narrow QB mutation (remove one line, or void the standalone invoice)
 *   4. ONLY on confirmed QB success → soft-cancel the Job (reuses removeOrder)
 *   5. append audit events at every step
 * If the QB mutation fails we never soft-cancel, so Pitt Stop and QuickBooks can never silently
 * disagree. Idempotency is anchored on the Job's own append-only event ledger + status.
 */
import { getDb } from '@/platform/db'
import { eq } from 'drizzle-orm'
import { jobEstimates, serviceOrderEvents } from './schema'
import { getOrderWithContext, removeOrder, logEvent, type OrderWithContext } from './db'
import { removalEligibility } from './removal'
import {
  decideQbRemovalPlan, planBlocksRemoval, planRequiresQbWrite,
  type RemovalLinkage, type QbInvoiceSnapshot, type QbRemovalPlan,
} from './removal-plan'
import { getScanByServiceOrderId } from '@/apps/dealer-checkin/db'
import { normalizeStock } from '@/apps/dealer-checkin/rules'
import {
  readDealerInvoiceSnapshot, readRetailInvoiceSnapshot, removeInvoiceLine, voidInvoice,
} from '@/apps/quickbooks/invoice-removal'
import { logger } from '@/platform/logger'

const APP = 'workflow:order-removal'

// Event types written to service_order_events (append-only audit ledger).
const QB_DONE_EVENTS = ['qb_line_removed', 'qb_invoice_voided', 'remove_completed']

function isDealerOrder(order: OrderWithContext): boolean {
  const src = (order.source ?? '').toLowerCase(), typ = (order.serviceType ?? '').toLowerCase()
  return src === 'dealer' || src === 'dealer_checkin' || typ.startsWith('dealer')
}

/** Build the stored linkage + read the live QB snapshot for this Job. Throws only on a QB read
 *  failure (caller turns that into a fail-closed "couldn't reach QuickBooks" — never a silent cancel). */
async function resolveLinkageAndSnapshot(order: OrderWithContext): Promise<{ link: RemovalLinkage; snap: QbInvoiceSnapshot | null }> {
  const db = getDb()
  if (isDealerOrder(order)) {
    const scan = await getScanByServiceOrderId(order.id)
    const hasQbLink = !!scan && scan.qbSyncStatus === 'synced' && !!scan.qbInvoiceNumber
    const stock = normalizeStock(scan?.stockNumber)
    const link: RemovalLinkage = {
      isDealer: true,
      hasQbLink,
      stockToken: stock ? `#${stock}` : null,
      storedLineId: scan?.qbLineId ?? null,
    }
    if (!hasQbLink) return { link, snap: null }
    const snap = await readDealerInvoiceSnapshot(scan!.qbInvoiceNumber!)
    return { link, snap }
  }
  // Retail — one estimate per order; QB identity proven via the PSID (estimate id) in PrivateNote.
  const [est] = await db.select({ id: jobEstimates.id, qbInvoiceId: jobEstimates.qbInvoiceId })
    .from(jobEstimates).where(eq(jobEstimates.serviceOrderId, order.id)).limit(1)
  const hasQbLink = !!est?.qbInvoiceId
  const link: RemovalLinkage = { isDealer: false, hasQbLink, stockToken: null, storedLineId: null }
  if (!hasQbLink) return { link, snap: null }
  const snap = await readRetailInvoiceSnapshot(est!.qbInvoiceId!, est!.id)
  return { link, snap }
}

// ── Human-readable preview (UI: what will happen before the manager confirms) ────────────────
export type RemovalPreviewKind = QbRemovalPlan['kind'] | 'already_removed' | 'qb_unreachable'
export interface RemovalPreview {
  kind:          RemovalPreviewKind
  isDealer:      boolean
  invoiceNumber: string | null
  /** SalesItemLineDetail lines that would REMAIN after a line removal (multi-vehicle case). */
  remainingLineCount?: number
  blocked:       boolean          // true ⇒ the Remove button must be hidden/disabled
  reason?:       string
}

function previewFromPlan(order: OrderWithContext, plan: QbRemovalPlan, snap: QbInvoiceSnapshot | null): RemovalPreview {
  const isDealer = isDealerOrder(order)
  const invoiceNumber = 'invoiceNumber' in plan ? plan.invoiceNumber : null
  const remainingLineCount = plan.kind === 'line_remove' && snap ? Math.max(0, snap.salesLines.length - 1) : undefined
  return {
    kind: plan.kind,
    isDealer,
    invoiceNumber,
    remainingLineCount,
    blocked: planBlocksRemoval(plan),
    reason: plan.kind === 'blocked_paid' ? plan.reason : plan.kind === 'ambiguous' ? plan.reason : undefined,
  }
}

/**
 * Read-only: what will happen if this Job is removed. Never mutates. On a QB read failure returns
 * kind='qb_unreachable' (the UI shows a soft warning; the POST re-checks and fails closed if the
 * outage persists).
 */
export async function planOrderRemoval(orderId: string): Promise<{ ok: boolean; error?: string; preview?: RemovalPreview }> {
  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, error: 'Job not found' }
  if (order.status === 'cancelled') {
    return { ok: true, preview: { kind: 'already_removed', isDealer: isDealerOrder(order), invoiceNumber: null, blocked: false } }
  }
  const gate = removalEligibility(order)
  if (!gate.ok) return { ok: false, error: gate.error }
  try {
    const { link, snap } = await resolveLinkageAndSnapshot(order)
    const plan = decideQbRemovalPlan(link, snap)
    return { ok: true, preview: previewFromPlan(order, plan, snap) }
  } catch (err) {
    logger.warn(APP, 'preview.qb_unreachable', { orderId, error: String(err) })
    return { ok: true, preview: { kind: 'qb_unreachable', isDealer: isDealerOrder(order), invoiceNumber: null, blocked: false } }
  }
}

// ── Execute ──────────────────────────────────────────────────────────────────────────────────
export interface RemovalResult {
  ok:            boolean
  alreadyRemoved?: boolean
  block?:        'payment_activity' | 'ambiguous' | 'qb_unreachable' | 'qb_write_failed' | 'not_eligible'
  error?:        string
  qbAction?:     'none' | 'line_removed' | 'invoice_voided' | 'already_done'
  invoiceNumber?: string | null
}

/** Has a prior attempt already corrected QuickBooks for this Job? (idempotency recovery signal) */
async function orderHasQbDoneEvent(orderId: string): Promise<boolean> {
  const db = getDb()
  const rows = await db.select({ t: serviceOrderEvents.eventType })
    .from(serviceOrderEvents)
    .where(eq(serviceOrderEvents.serviceOrderId, orderId))
  return rows.some((r) => QB_DONE_EVENTS.includes(r.t))
}

/**
 * Perform the coordinated removal. Manager/admin authorization is enforced by the API route; this
 * function assumes an authorized actor and focuses on the atomic QB-then-cancel sequence.
 */
export async function executeOrderRemoval(params: { orderId: string; actor: string | null }): Promise<RemovalResult> {
  const { orderId, actor } = params
  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, error: 'Job not found' }

  // Idempotency #1 — the Job is already removed. Return the successful terminal state, touch nothing.
  if (order.status === 'cancelled') return { ok: true, alreadyRemoved: true, qbAction: 'already_done' }

  const gate = removalEligibility(order)
  if (!gate.ok) return { ok: false, block: 'not_eligible', error: gate.error }

  await logEvent({ serviceOrderId: orderId, eventType: 'remove_requested', employeeName: actor, oldStatus: order.status })

  // Idempotency #2 — a prior attempt already corrected QB but did not finish the soft-cancel
  // (e.g. crashed between steps). Recover by skipping QB entirely and completing the cancel.
  if (await orderHasQbDoneEvent(orderId)) {
    const soft = await removeOrder({ orderId, actor })
    if (!soft.ok) return { ok: false, block: 'qb_write_failed', error: soft.error }
    await logEvent({ serviceOrderId: orderId, eventType: 'remove_completed', employeeName: actor, newStatus: 'cancelled', note: 'recovered — QuickBooks already corrected in a prior attempt' })
    return { ok: true, qbAction: 'already_done' }
  }

  // 1. Prove linkage + read live QB state.
  let link: RemovalLinkage, snap: QbInvoiceSnapshot | null
  try {
    ({ link, snap } = await resolveLinkageAndSnapshot(order))
  } catch (err) {
    await logEvent({ serviceOrderId: orderId, eventType: 'remove_failed', employeeName: actor, note: `QuickBooks unreachable: ${String(err)}` })
    return { ok: false, block: 'qb_unreachable', error: 'Could not reach QuickBooks to verify the invoice. Nothing was changed — please try again.' }
  }
  const plan = decideQbRemovalPlan(link, snap)

  // 2. Fail closed — never touch QB, never soft-cancel (avoid an inconsistent split state).
  if (plan.kind === 'blocked_paid') {
    await logEvent({ serviceOrderId: orderId, eventType: 'remove_failed', employeeName: actor, note: `blocked: payment activity on invoice #${plan.invoiceNumber ?? '?'}` })
    return { ok: false, block: 'payment_activity', invoiceNumber: plan.invoiceNumber, error: 'This invoice has payment activity and cannot be automatically removed. Review the invoice in QuickBooks.' }
  }
  if (plan.kind === 'ambiguous') {
    await logEvent({ serviceOrderId: orderId, eventType: 'remove_failed', employeeName: actor, note: `blocked: ambiguous QB linkage (${plan.reason})` })
    return { ok: false, block: 'ambiguous', error: 'This vehicle could not be safely matched to an exact QuickBooks invoice line, so nothing was changed. Review the invoice in QuickBooks.' }
  }

  // 3. Narrow QB mutation (only when the plan requires one).
  let qbAction: RemovalResult['qbAction'] = 'none'
  let invoiceNumber: string | null = 'invoiceNumber' in plan ? plan.invoiceNumber : null
  if (planRequiresQbWrite(plan)) {
    if (plan.kind === 'line_remove') {
      const w = await removeInvoiceLine({ invoiceId: plan.invoiceId, lineId: plan.lineId })
      if (!w.ok) {
        await logEvent({ serviceOrderId: orderId, eventType: 'remove_failed', employeeName: actor, note: `QB line removal failed on #${plan.invoiceNumber ?? '?'}: ${w.error}` })
        return { ok: false, block: 'qb_write_failed', invoiceNumber: plan.invoiceNumber, error: 'Could not update the QuickBooks invoice. Nothing was removed — please try again.' }
      }
      qbAction = 'line_removed'; invoiceNumber = w.invoiceNumber ?? plan.invoiceNumber
      await logEvent({ serviceOrderId: orderId, eventType: 'qb_line_removed', employeeName: actor, note: `#${invoiceNumber ?? '?'} line ${plan.lineId}${w.idempotent ? ' (already gone)' : ''} · total $${((w.totalCentsBefore ?? 0) / 100).toFixed(2)} → $${((w.totalCentsAfter ?? 0) / 100).toFixed(2)}` })
    } else if (plan.kind === 'void_standalone') {
      const w = await voidInvoice({ invoiceId: plan.invoiceId })
      if (!w.ok) {
        await logEvent({ serviceOrderId: orderId, eventType: 'remove_failed', employeeName: actor, note: `QB void failed on #${plan.invoiceNumber ?? '?'}: ${w.error}` })
        return { ok: false, block: 'qb_write_failed', invoiceNumber: plan.invoiceNumber, error: 'Could not void the QuickBooks invoice. Nothing was removed — please try again.' }
      }
      qbAction = 'invoice_voided'; invoiceNumber = w.invoiceNumber ?? plan.invoiceNumber
      await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_voided', employeeName: actor, note: `#${invoiceNumber ?? '?'}${w.idempotent ? ' (already voided)' : ''} · was $${((w.totalCentsBefore ?? 0) / 100).toFixed(2)}` })
    }
  } else if (plan.kind === 'idempotent_qb_done') {
    qbAction = 'already_done'
  }

  // 4. Soft-cancel — only reached when QB is confirmed in the desired state (every block/failure
  //    path returned above, so shouldSoftCancel(plan, …) is guaranteed true here).
  const soft = await removeOrder({ orderId, actor })
  if (!soft.ok) {
    // QB is already corrected but the DB cancel failed — the event ledger lets a retry recover.
    await logEvent({ serviceOrderId: orderId, eventType: 'remove_failed', employeeName: actor, note: `soft-cancel failed after QB ${qbAction}: ${soft.error}` })
    return { ok: false, block: 'qb_write_failed', invoiceNumber, error: 'The invoice was corrected but removing the Job failed. Tap Remove again to finish.' }
  }
  await logEvent({ serviceOrderId: orderId, eventType: 'remove_completed', employeeName: actor, newStatus: 'cancelled', note: `qbAction=${qbAction}${invoiceNumber ? ` · #${invoiceNumber}` : ''}` })
  logger.info(APP, 'removed', { orderId, qbAction, invoiceNumber })
  return { ok: true, qbAction, invoiceNumber }
}
