import { describe, it, expect } from 'vitest'
import {
  ACTIVE_WORK_STATUSES,
  isActiveWorkStatus,
  isRemovalAuthorizedRole,
  removalEligibility,
  isCancelledOrRemoved,
  scanSyncStatusAfterRemoval,
  REMOVED_SCAN_SYNC_STATUS,
} from './removal'

// These pure rules are the single source of truth that removeOrder (apps/workflow/db.ts), the
// Work Board active filter, Production, the CFO inflow queries, and the dealer-scan queue drain
// all enforce. Testing them here proves the removal semantics without a live database.

describe('removalEligibility — a manager can remove an accidental retail OR dealer check-in', () => {
  it('allows removing a DEALER vehicle that is still active work', () => {
    // A dealer Job (source=dealer / service_type=dealer_detail) checked in by mistake.
    for (const status of ACTIVE_WORK_STATUSES) {
      expect(removalEligibility({ status })).toEqual({ ok: true })
    }
  })

  it('allows removing a RETAIL vehicle that is still active work', () => {
    expect(removalEligibility({ status: 'arrived' })).toEqual({ ok: true })
    expect(removalEligibility({ status: 'in_progress' })).toEqual({ ok: true })
  })

  it('QuickBooks linkage is NOT an input — it never blocks eligibility (caller warns instead)', () => {
    // Eligibility depends only on lifecycle. A QB-linked Job is just as removable.
    expect(removalEligibility({ status: 'qc_ready' })).toEqual({ ok: true })
  })

  it('refuses a Ready / Delivered / Cancelled Job so a finished or counted Job is never erased', () => {
    for (const status of ['ready', 'delivered', 'cancelled']) {
      const r = removalEligibility({ status })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(status)
    }
  })
})

describe('isRemovalAuthorizedRole — manager/admin only; non-managers gain nothing', () => {
  it('allows manager (Torlan/Darryl/Tony) and admin', () => {
    expect(isRemovalAuthorizedRole('manager')).toBe(true)
    expect(isRemovalAuthorizedRole('admin')).toBe(true)
  })

  it('refuses employee, unknown, empty, and missing roles', () => {
    expect(isRemovalAuthorizedRole('employee')).toBe(false)
    expect(isRemovalAuthorizedRole('tech')).toBe(false)
    expect(isRemovalAuthorizedRole('')).toBe(false)
    expect(isRemovalAuthorizedRole(null)).toBe(false)
    expect(isRemovalAuthorizedRole(undefined)).toBe(false)
  })
})

describe('active-board exclusion — a removed (cancelled) Job disappears from the active board', () => {
  it('every active-work status is shown; cancelled/delivered/ready are not active', () => {
    for (const status of ACTIVE_WORK_STATUSES) expect(isActiveWorkStatus(status)).toBe(true)
    expect(isActiveWorkStatus('cancelled')).toBe(false)   // removed → off the active board
    expect(isActiveWorkStatus('delivered')).toBe(false)
    expect(isActiveWorkStatus('ready')).toBe(false)
  })
})

describe('isCancelledOrRemoved — the invariant Production and the CFO queries mirror in SQL', () => {
  it('a removed Job (status=cancelled + cancelled_at) is excluded everywhere', () => {
    // productionRows uses `so.status <> 'cancelled'`; CFO inflow uses `so.cancelled_at is null`.
    const removed = { status: 'cancelled', cancelledAt: new Date() }
    expect(isCancelledOrRemoved(removed)).toBe(true)                       // not counted in Production
    expect(isCancelledOrRemoved({ cancelledAt: new Date() })).toBe(true)  // excluded from CFO earned/uninvoiced
  })

  it('an active Job is NOT excluded', () => {
    expect(isCancelledOrRemoved({ status: 'in_progress', cancelledAt: null })).toBe(false)
    expect(isCancelledOrRemoved({ status: 'ready' })).toBe(false)
  })
})

describe('scanSyncStatusAfterRemoval — a removed dealer Job can never re-batch to QuickBooks', () => {
  it('a QUEUED dealer scan is flipped out of the queue (drain reads qb_sync_status=queued)', () => {
    // listQueuedScans selects qb_sync_status='queued'; after removal it is no longer queued,
    // so retryQueuedCheckIns will never push this mistaken vehicle to QuickBooks.
    expect(scanSyncStatusAfterRemoval('queued')).toBe(REMOVED_SCAN_SYNC_STATUS)
    expect(scanSyncStatusAfterRemoval('queued')).not.toBe('queued')
  })

  it('an already-synced / errored / unknown scan is left untouched (we never re-touch QuickBooks)', () => {
    expect(scanSyncStatusAfterRemoval('synced')).toBe('synced')
    expect(scanSyncStatusAfterRemoval('error')).toBe('error')
    expect(scanSyncStatusAfterRemoval(null)).toBe(null)
    expect(scanSyncStatusAfterRemoval(undefined)).toBe(undefined)
  })

  it('never produces a status that the queue drain would pick up', () => {
    for (const input of ['queued', 'synced', 'error', null, undefined]) {
      expect(scanSyncStatusAfterRemoval(input)).not.toBe('queued')
    }
  })
})
