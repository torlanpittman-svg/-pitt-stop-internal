/**
 * Pure decision rules for the Work Board "Remove from Work Board" action — a manager/admin
 * soft-cancel of a mistaken or duplicate check-in (retail OR dealer). No DB imports: this is
 * the single source of the rules that removeOrder (apps/workflow/db.ts) enforces and that the
 * unit tests exercise.
 *
 * A removed Job is a SOFT cancel — status='cancelled' + cancelled_at, never a hard delete.
 * Every downstream reader already excludes cancelled Jobs, so removal needs NO new status
 * system (see isCancelledOrRemoved):
 *   - active Work Board .......... listActiveOrders() + isActiveWorkStatus() below
 *   - Daily/Weekly Production ..... productionRows: `so.status <> 'cancelled'`
 *   - CFO earned / uninvoiced ..... inflow queries: `so.cancelled_at is null`
 *   - dealer invoice batching ..... scanSyncStatusAfterRemoval() drops it from the queue drain
 */

// The active-work statuses — the DEFAULT Work Board view, and the ONLY statuses a Job may be
// removed from. Once a Job is Ready/Delivered/Cancelled it has left active work.
export const ACTIVE_WORK_STATUSES = ['arrived', 'in_progress', 'paused', 'drying', 'qc_ready'] as const

/** True while a Job still needs shop work (shows on the active board, and is removable). */
export function isActiveWorkStatus(status: string): boolean {
  return (ACTIVE_WORK_STATUSES as readonly string[]).includes(status)
}

/**
 * Roles allowed to remove a Job from the Work Board: MANAGER + ADMIN only. Employees — and any
 * unknown/absent role — are refused. The API route enforces this server-side from the signed
 * session; it never trusts a client-writable value. (Managers ≠ admin: removal deliberately does
 * NOT require ADMIN_PASSWORD, so Torlan/Darryl/Tony can correct an accidental check-in.)
 */
export function isRemovalAuthorizedRole(role: string | null | undefined): boolean {
  return role === 'manager' || role === 'admin'
}

/**
 * Whether an active-work Job can be removed from the Work Board. Retail AND dealer are both
 * removable — removal is a correction for an accidental check-in, so QuickBooks linkage NEVER
 * blocks it (the caller warns instead of blocking). Only the lifecycle gate applies: a
 * Ready/Delivered/Cancelled Job is refused so a finished, counted, or already-removed Job is
 * never silently erased.
 */
export function removalEligibility(order: { status: string }): { ok: true } | { ok: false; error: string } {
  if (isActiveWorkStatus(order.status)) return { ok: true }
  return { ok: false, error: `Only an active Job can be removed (this Job is ${order.status}).` }
}

/**
 * The canonical "excluded everywhere" predicate. A removed Job is status='cancelled' with
 * cancelled_at set; the active board, Production, CFO earned/uninvoiced, and dealer-invoice
 * batching all drop it. Mirrors the SQL guards so the invariant is unit-tested in one place.
 */
export function isCancelledOrRemoved(order: { status?: string | null; cancelledAt?: Date | string | null }): boolean {
  return order.status === 'cancelled' || order.cancelledAt != null
}

/** The dealer-scan sync status that marks a removed check-in as "do not batch to QuickBooks". */
export const REMOVED_SCAN_SYNC_STATUS = 'removed'

/**
 * A removed DEALER Job's check-in scan must never re-batch to QuickBooks. The queue drain
 * (retryQueuedCheckIns → listQueuedScans) selects qb_sync_status='queued'; flipping a queued
 * scan to 'removed' drops it from that drain. This PREVENTS a future QB write and performs
 * none. A scan that already synced (or errored) is left untouched — we never re-touch QB.
 */
export function scanSyncStatusAfterRemoval(current: string | null | undefined): string | null | undefined {
  return current === 'queued' ? REMOVED_SCAN_SYNC_STATUS : current
}
