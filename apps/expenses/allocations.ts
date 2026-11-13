/**
 * Expense allocations — PURE rules (no server deps; shared by the DB layer, the UI and tests).
 *
 * A purchase is ONE business_receipts row. An allocation points part or all of that purchase at a customer
 * job or at overhead. It is never a second expense: nothing here (or anywhere) adds allocation amounts to a
 * business total. These helpers only answer "how much of THIS purchase is spoken for, and is that sane?".
 *
 *   amountCents === null → the WHOLE purchase (its effective amount follows the receipt total)
 *   amountCents  >  0    → an explicit split amount
 */
export const ALLOCATION_TARGETS = ['job', 'overhead'] as const
export type AllocationTarget = (typeof ALLOCATION_TARGETS)[number]
export function isAllocationTarget(t: unknown): t is AllocationTarget {
  return typeof t === 'string' && (ALLOCATION_TARGETS as readonly string[]).includes(t)
}

export interface AllocationLike { amountCents: number | null; status?: string | null }

/** What one allocation is worth right now. A whole-purchase allocation is worth the receipt total (null
 *  while the total is still unknown — never coerced to $0). */
export function effectiveAmountCents(a: AllocationLike, receiptTotalCents: number | null | undefined): number | null {
  if (a.amountCents != null) return a.amountCents
  return receiptTotalCents ?? null
}

export type AllocationState =
  | 'unallocated'    // nothing points anywhere (ordinary general expense)
  | 'partial'        // some of the purchase is allocated; a remainder is still unassigned
  | 'full'           // every cent is allocated
  | 'over'           // allocations exceed the purchase total — a discrepancy to fix
  | 'unknown_total'  // allocated, but the receipt total isn't known yet

export interface AllocationSummary {
  state: AllocationState
  totalCents: number | null
  allocatedCents: number | null   // null only when a whole-purchase allocation exists and the total is unknown
  unallocatedCents: number | null // the visible remainder (never negative)
  overCents: number               // how far allocations exceed the total (0 unless state === 'over')
  whole: boolean                  // an active whole-purchase allocation exists
  activeCount: number
}

const isActive = (a: AllocationLike) => (a.status ?? 'active') === 'active'

/** Reconcile a purchase's ACTIVE allocations against its total. Removed allocations never count. */
export function summarizeAllocations(receiptTotalCents: number | null | undefined, allocations: readonly AllocationLike[]): AllocationSummary {
  const active = allocations.filter(isActive)
  const total = receiptTotalCents ?? null
  const whole = active.some((a) => a.amountCents == null)
  if (active.length === 0) {
    return { state: 'unallocated', totalCents: total, allocatedCents: 0, unallocatedCents: total, overCents: 0, whole: false, activeCount: 0 }
  }
  if (total == null) {
    const explicit = active.reduce((s, a) => s + (a.amountCents ?? 0), 0)
    return { state: 'unknown_total', totalCents: null, allocatedCents: whole ? null : explicit, unallocatedCents: null, overCents: 0, whole, activeCount: active.length }
  }
  const allocated = active.reduce((s, a) => s + (effectiveAmountCents(a, total) ?? 0), 0)
  const over = Math.max(0, allocated - total)
  const state: AllocationState = over > 0 ? 'over' : allocated === total ? 'full' : 'partial'
  return { state, totalCents: total, allocatedCents: allocated, unallocatedCents: Math.max(0, total - allocated), overCents: over, whole, activeCount: active.length }
}

export type AllocationCheck = { ok: true } | { ok: false; error: string }

/**
 * May a NEW allocation be added to this purchase? Guarantees the active allocations can never exceed the
 * purchase total, and that a whole-purchase allocation never coexists with another one.
 *   - whole purchase (amountCents null): only when nothing else is allocated.
 *   - split amount: needs a known total, a positive amount, no existing whole-purchase allocation, and
 *     existing + new ≤ total.
 */
export function checkNewAllocation(receiptTotalCents: number | null | undefined, existing: readonly AllocationLike[], amountCents: number | null): AllocationCheck {
  const active = existing.filter(isActive)
  if (amountCents == null) {
    if (active.length > 0) return { ok: false, error: 'This purchase is already assigned. Enter the amount for this part of it, or remove the other assignment first.' }
    return { ok: true }
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'Enter an amount greater than $0.' }
  if (active.some((a) => a.amountCents == null)) return { ok: false, error: 'The whole purchase is already assigned. Change that assignment to a split amount first.' }
  const total = receiptTotalCents ?? null
  if (total == null) return { ok: false, error: 'Enter the receipt total before splitting it.' }
  const already = active.reduce((s, a) => s + (a.amountCents ?? 0), 0)
  if (already + amountCents > total) {
    const left = Math.max(0, total - already)
    return { ok: false, error: `That is more than what is left on this purchase ($${(left / 100).toFixed(2)} unassigned of $${(total / 100).toFixed(2)}).` }
  }
  return { ok: true }
}
