/**
 * Void the QuickBooks invoice that was created for a vehicle BEFORE it was moved back to Estimates.
 *
 * "Move to Estimates" is a pure Pitt Stop status move and deliberately leaves any linked invoice alone
 * (owner decision 2026-10-05). An estimate should not carry a live invoice, though, so this is the one
 * explicit, separate correction for that leftover: a manager names the exact invoice number and it is
 * voided — never as a side effect of the move, never for a Job on the Work Board (that is Remove).
 *
 * Fail-closed, narrow, idempotent. It reuses the Work Board Remove machinery (PSID-proven snapshot,
 * the pure removal planner, the void writer) and refuses when anything is uncertain:
 *   · the order is not in Estimates, is a dealer vehicle, or has no linked invoice;
 *   · the invoice number given does not match the linked invoice (in Pitt Stop AND in QuickBooks);
 *   · the invoice is shared with another Job, was sent, or has any payment/credit activity;
 *   · QuickBooks cannot be read, or the invoice cannot be proven to be this estimate's (PSID).
 * Void, never delete: the number and history stay in QuickBooks with zero financial effect.
 * After a confirmed void the dead link is cleared and a 'qb_invoice_voided' event is appended in ONE
 * statement; a crash between the void and that statement recovers on retry (already voided → finish).
 * Manager/admin authorization and the intake lock are the calling route's job.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { isDealerOrder } from '@/apps/workflow/fees'
import { decideQbRemovalPlan, type QbInvoiceSnapshot } from '@/apps/workflow/removal-plan'
import { readRetailInvoiceSnapshot, voidInvoice } from '@/apps/quickbooks/invoice-removal'
import { logger } from '@/platform/logger'

const APP = 'estimates:void-linked-invoice'

export type VoidBlockCode =
  | 'not_found' | 'not_estimate' | 'dealer' | 'no_invoice' | 'number_mismatch' | 'shared_invoice'
  | 'invoice_sent' | 'payment_activity' | 'ambiguous' | 'qb_unreachable' | 'qb_write_failed'

export interface VoidLinkedInvoiceResult {
  ok:             boolean
  code?:          VoidBlockCode
  error?:         string
  alreadyDone?:   boolean          // nothing left to do (a prior attempt already finished)
  qbAction?:      'invoice_voided' | 'already_voided'
  invoiceId?:     string
  invoiceNumber?: string | null
  wasCents?:      number
}

interface Row {
  status: string; source: string | null; serviceType: string | null
  estimateId: string | null; qbInvoiceId: string | null; qbInvoiceNumber: string | null
  qbStatus: string | null; qbSentAt: unknown; qbPaymentStatus: string | null; qbPaymentId: string | null
  sharedCount: number; priorVoids: number
}

const refuse = (code: VoidBlockCode, error: string, extra: Partial<VoidLinkedInvoiceResult> = {}): VoidLinkedInvoiceResult =>
  ({ ok: false, code, error, ...extra })

async function readRow(orderId: string): Promise<Row | null> {
  const { rows } = await getDb().execute(sql`
    SELECT so.status, so.source, so.service_type AS "serviceType",
      e.id AS "estimateId", e.qb_invoice_id AS "qbInvoiceId", e.qb_invoice_number AS "qbInvoiceNumber",
      e.qb_status AS "qbStatus", e.qb_sent_at AS "qbSentAt",
      e.qb_payment_status AS "qbPaymentStatus", e.qb_payment_id AS "qbPaymentId",
      (SELECT count(*) FROM retail_invoice_members m WHERE m.state <> 'removed'
         AND (m.anchor_estimate_id = e.id OR m.member_estimate_id = e.id))::int AS "sharedCount",
      (SELECT count(*) FROM service_order_events ev WHERE ev.service_order_id = so.id
         AND ev.event_type = 'qb_invoice_voided')::int AS "priorVoids"
    FROM service_orders so
    LEFT JOIN job_estimates e ON e.service_order_id = so.id
    WHERE so.id = ${orderId}::uuid
    LIMIT 1`)
  return (rows[0] as unknown as Row) ?? null
}

export async function voidLinkedInvoiceForEstimate(params: {
  orderId: string; expectedInvoiceNumber: string; actor: string | null
}): Promise<VoidLinkedInvoiceResult> {
  const { orderId, actor } = params
  const expected = String(params.expectedInvoiceNumber ?? '').trim()
  const row = await readRow(orderId)
  if (!row) return refuse('not_found', 'Estimate not found.')
  if (isDealerOrder({ source: row.source, serviceType: row.serviceType })) return refuse('dealer', 'Dealer invoices are not changed here.')
  if (row.status !== 'estimate') return refuse('not_estimate', 'Only an estimate’s leftover invoice can be voided here. For a Job on the Work Board, use Remove.')
  if (!row.estimateId || !row.qbInvoiceId) {
    // Repeat click after a finished void → the successful terminal state, nothing touched.
    if (row.priorVoids > 0) return { ok: true, alreadyDone: true, qbAction: 'already_voided' }
    return refuse('no_invoice', 'This estimate has no QuickBooks invoice, so there is nothing to void.')
  }
  const invoiceId = row.qbInvoiceId
  if (!expected || expected !== String(row.qbInvoiceNumber ?? '').trim()) {
    return refuse('number_mismatch', `That is not this estimate’s invoice. The linked invoice is #${row.qbInvoiceNumber ?? '?'}.`, { invoiceNumber: row.qbInvoiceNumber })
  }
  if (row.sharedCount > 0) return refuse('shared_invoice', 'This invoice is shared with another Job. Separate the Jobs before voiding.', { invoiceNumber: row.qbInvoiceNumber })
  if (row.qbStatus === 'sent' || row.qbSentAt != null) {
    return refuse('invoice_sent', `Invoice #${expected} was already sent to the customer. Review it in QuickBooks.`, { invoiceNumber: expected })
  }
  if ((row.qbPaymentStatus && row.qbPaymentStatus !== 'none') || row.qbPaymentId) {
    return refuse('payment_activity', `Invoice #${expected} has payment activity and was not changed. Review it in QuickBooks.`, { invoiceNumber: expected })
  }

  // Live QuickBooks state, identity proven by the PSID marker (this estimate's id).
  let snap: QbInvoiceSnapshot
  try { snap = await readRetailInvoiceSnapshot(invoiceId, row.estimateId) }
  catch (err) {
    logger.warn(APP, 'qb_unreachable', { orderId, error: String(err) })
    return refuse('qb_unreachable', 'Could not reach QuickBooks to verify the invoice. Nothing was changed — please try again.', { invoiceNumber: expected })
  }
  const plan = decideQbRemovalPlan({ isDealer: false, hasQbLink: true, stockToken: null, storedLineId: null }, snap)
  if (plan.kind === 'ambiguous') return refuse('ambiguous', 'This invoice could not be proven to belong to this estimate, so nothing was changed. Review it in QuickBooks.', { invoiceNumber: expected })
  if (plan.kind === 'blocked_paid') return refuse('payment_activity', `Invoice #${expected} has payment or credit activity and was not changed. Review it in QuickBooks.`, { invoiceNumber: expected })
  if (snap.status === 'resolved' && String(snap.invoiceNumber ?? '').trim() !== expected) {
    return refuse('number_mismatch', `QuickBooks shows a different number (#${snap.invoiceNumber ?? '?'}) for the linked invoice. Nothing was changed.`, { invoiceNumber: snap.invoiceNumber })
  }

  let qbAction: VoidLinkedInvoiceResult['qbAction'] = 'already_voided'
  let wasCents = snap.totalCents
  if (plan.kind === 'void_standalone') {
    if ((snap.emailStatus ?? '').toLowerCase() === 'emailsent') {
      return refuse('invoice_sent', `Invoice #${expected} was already sent to the customer. Review it in QuickBooks.`, { invoiceNumber: expected })
    }
    const w = await voidInvoice({ invoiceId })
    if (!w.ok) {
      logger.error(APP, 'void_failed', { orderId, invoiceId, error: w.error })
      return refuse('qb_write_failed', 'Could not void the QuickBooks invoice. Nothing was changed — please try again.', { invoiceNumber: expected })
    }
    qbAction = w.idempotent ? 'already_voided' : 'invoice_voided'
    wasCents = w.totalCentsBefore ?? snap.totalCents
  } else if (plan.kind !== 'idempotent_qb_done') {
    return refuse('ambiguous', 'This invoice could not be safely identified, so nothing was changed.', { invoiceNumber: expected })
  }

  // QuickBooks is confirmed voided → clear the dead link and append the audit event, atomically.
  const note = `#${expected} (${invoiceId}) voided — vehicle was entered as a Job by mistake and is an estimate`
    + `${qbAction === 'already_voided' ? ' (already voided in QuickBooks)' : ''} · was $${(wasCents / 100).toFixed(2)}`
  await getDb().execute(sql`
    WITH cleared AS (
      UPDATE job_estimates SET qb_invoice_id = NULL, qb_invoice_number = NULL, qb_sync_token = NULL,
        qb_content_hash = NULL, qb_lines_fingerprint = NULL, qb_sync_error = NULL, qb_synced_at = NULL,
        qb_status = 'none', updated_at = now(), updated_by = ${actor}
      WHERE id = ${row.estimateId}::uuid AND qb_invoice_id = ${invoiceId}
      RETURNING service_order_id
    )
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
    SELECT service_order_id, 'qb_invoice_voided', ${actor}, ${note} FROM cleared`)
  logger.info(APP, 'voided', { orderId, invoiceId, invoiceNumber: expected, qbAction })
  return { ok: true, qbAction, invoiceId, invoiceNumber: expected, wasCents }
}
