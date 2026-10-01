/**
 * Pure parts status & quantity logic — no I/O, fully unit-testable.
 *
 * Invariants enforced here (the db layer calls these; it never re-derives status by hand):
 *   - A part starts 'needed'. It becomes 'ordered' ONLY when a real order is recorded
 *     (a supplier or a supplier order/confirmation number). canMarkOrdered() gates that.
 *   - Receiving clamps to [0, quantity] and derives 'received' vs 'partially_received'.
 *   - 'cancelled' is terminal; receiving/returning never resurrect it.
 *   - "Waiting on parts" = any non-terminal part not yet fully received.
 */

export const PART_STATUSES = ['needed', 'ordered', 'partially_received', 'received', 'cancelled'] as const
export type PartStatus = (typeof PART_STATUSES)[number]

export interface PartState {
  status: PartStatus
  quantity: number
  receivedQuantity: number
  returnedQuantity: number
  supplier?: string | null
  supplierOrderNumber?: string | null
}

export function isPartStatus(s: string): s is PartStatus {
  return (PART_STATUSES as readonly string[]).includes(s)
}

/**
 * A part may be marked 'ordered' only when an actual order was recorded — a supplier name OR a
 * supplier order/confirmation number. This is what keeps a merely-saved part from reading as ordered.
 */
export function canMarkOrdered(input: { supplier?: string | null; supplierOrderNumber?: string | null }): boolean {
  return Boolean((input.supplier && input.supplier.trim()) || (input.supplierOrderNumber && input.supplierOrderNumber.trim()))
}

/** Derive status purely from received quantity for a non-terminal, ordered part. */
export function deriveReceivedStatus(quantity: number, received: number): Extract<PartStatus, 'ordered' | 'partially_received' | 'received'> {
  if (quantity > 0 && received >= quantity) return 'received'
  if (received > 0) return 'partially_received'
  return 'ordered'
}

/**
 * Apply a received quantity delta. Returns the new receivedQuantity (clamped) and status.
 * Receiving a cancelled part is a no-op. Receiving a 'needed' (not-yet-ordered) part implicitly
 * records receipt but DOES NOT invent an order — it moves straight to partially/received.
 */
export function applyReceipt(part: PartState, deltaQty: number): { receivedQuantity: number; status: PartStatus } {
  if (part.status === 'cancelled') return { receivedQuantity: part.receivedQuantity, status: 'cancelled' }
  const next = clamp(part.receivedQuantity + deltaQty, 0, part.quantity)
  return { receivedQuantity: next, status: deriveReceivedStatus(part.quantity, next) }
}

/** Record a return / core credit. Returns the accumulated returned quantity (clamped to quantity). */
export function applyReturn(part: PartState, returnQty: number): { returnedQuantity: number } {
  const next = clamp(part.returnedQuantity + Math.max(0, returnQty), 0, part.quantity)
  return { returnedQuantity: next }
}

/** Outstanding (not-yet-received) quantity for a non-terminal part. */
export function outstandingQuantity(part: PartState): number {
  if (part.status === 'cancelled' || part.status === 'received') return 0
  return Math.max(0, part.quantity - part.receivedQuantity)
}

/** Is this specific part still being waited on (ordered/needed/partially, not received/cancelled)? */
export function isPartWaiting(status: string): boolean {
  return status === 'needed' || status === 'ordered' || status === 'partially_received'
}

/** Does an order have any outstanding parts? Drives the Work Board "waiting on parts" badge. */
export function orderHasWaitingParts(parts: Array<{ status: string }>): boolean {
  return parts.some((p) => isPartWaiting(p.status))
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  if (hi < lo) return lo
  return Math.min(Math.max(n, lo), hi)
}
