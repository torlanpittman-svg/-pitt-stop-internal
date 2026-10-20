/**
 * Retail invoice write locks — payment recording vs invoice-changing operations (Sync, charge changes).
 *
 * Exclusion lives IN the compare-and-set statements, on the one job_estimates row: each lock's WHERE
 * clause also requires the other side to be idle, so Postgres' row lock orders the two UPDATEs and the
 * loser's WHERE is re-evaluated against the winner's committed row. Neither can slip in between the
 * other's check and its lock. (neon-http has no transactions; a single conditional UPDATE is atomic.)
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { jobEstimates } from '@/apps/workflow/schema'
import { PAYMENT_LOCKS_INVOICE } from './retail-payment'

/** qb_status values during which the linked invoice's content may be changing (Record Payment waits). */
export const INVOICE_CHANGING_STATUSES = ['creating', 'syncing']

/** The Record Payment attempt that holds the payment lock (qb_payment_status='recording'). */
export interface PaymentLockOwner { requestId: string; startedAt: Date }

/** Take the Sync lock (qb_status → 'syncing') from a settled state, and only while no payment is
 *  recorded / being recorded / unconfirmed on the invoice. One winner.
 *  `owner`: Record Payment (Cash / Check card-fee removal) syncing the invoice UNDER its own payment lock —
 *  allowed only while that exact attempt (request id + lock time) still holds it, so a superseded worker can
 *  never sync, and no other payment attempt or Sync can interleave. */
export async function acquireRetailSyncLock(estimateId: string, owner?: PaymentLockOwner): Promise<boolean> {
  const paymentSide = owner
    ? and(eq(jobEstimates.qbPaymentStatus, 'recording'), eq(jobEstimates.qbPaymentRequestId, owner.requestId), eq(jobEstimates.qbPaymentStartedAt, owner.startedAt))
    : notInArray(jobEstimates.qbPaymentStatus, [...PAYMENT_LOCKS_INVOICE])
  const locked = await getDb().update(jobEstimates)
    .set({ qbStatus: 'syncing', updatedAt: new Date() })
    .where(and(
      eq(jobEstimates.id, estimateId),
      inArray(jobEstimates.qbStatus, ['created', 'sent', 'error']),
      paymentSide,
    ))
    .returning({ id: jobEstimates.id })
  return locked.length > 0
}
