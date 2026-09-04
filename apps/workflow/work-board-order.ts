/**
 * Canonical Work Board DISPLAY ordering.
 *
 * The board shows what needs attention first — NOT merely what was entered first. Priority groups
 * (lower rank = higher on the board):
 *   0. URGENT vehicles          — any source (Dealer OR Retail); urgent always outranks non-urgent
 *   1. non-urgent RETAIL        — retail customer vehicles ahead of dealer work
 *   2. non-urgent DEALER
 *   3. non-urgent UNKNOWN        — unclassified source, sorted last among non-urgent
 *
 * Within a group the existing sensible ordering is preserved: the incoming list arrives oldest-first
 * (arrivedAt ascending from listActiveOrders), and the sort is STABLE, so same-priority vehicles keep
 * that age order. This is DISPLAY priority only — it never changes status, urgency persistence, fees,
 * Production ordering, or QuickBooks behavior.
 */
import { orderSourceKind } from './fees'

export type BoardSortable = {
  isUrgent?: boolean | null
  source?: string | null
  serviceType?: string | null
}

/** Priority rank for the Work Board (lower sorts first). See module docstring for the group order. */
export function workBoardRank(o: BoardSortable): number {
  if (o.isUrgent === true) return 0
  const kind = orderSourceKind(o)
  if (kind === 'retail') return 1
  if (kind === 'dealer') return 2
  return 3
}

/**
 * Sort orders for the Work Board: by priority rank, then preserve the incoming (age) order within each
 * group. Stable — same-rank vehicles retain their original relative order. Pure/non-mutating.
 */
export function sortWorkBoard<T extends BoardSortable>(orders: readonly T[]): T[] {
  return orders
    .map((o, i) => [o, i] as const)
    .sort((a, b) => (workBoardRank(a[0]) - workBoardRank(b[0])) || (a[1] - b[1]))
    .map(([o]) => o)
}
