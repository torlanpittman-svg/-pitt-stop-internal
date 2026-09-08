/**
 * Pure decision logic for coordinating a Work Board removal with its linked QuickBooks invoice.
 * NO I/O — given the proven linkage plus a snapshot of the QB invoice, decide EXACTLY what
 * QuickBooks action (if any) the removal should perform. The orchestrator
 * (apps/workflow/order-removal.ts) does the reads/writes; this module is the fail-closed brain
 * and is heavily unit-tested.
 *
 * The overriding rule: NEVER guess. Any ambiguity → { kind: 'ambiguous' } and QuickBooks is left
 * untouched (and the orchestrator refuses the operational removal too, so Pitt Stop and QB can
 * never silently disagree). Payment activity → { kind: 'blocked_paid' }. Only when the exact
 * erroneous line (dealer) or the standalone invoice identity (retail) is proven do we mutate.
 */

/** One SalesItemLineDetail line as read from QuickBooks (only what the decision needs). */
export interface QbSalesLine {
  id:          string
  description: string
  amountCents: number
}

export type SnapshotStatus = 'resolved' | 'not_found' | 'ambiguous'

/** Snapshot of the linked QB invoice at plan time. `status` says whether we pinned exactly one. */
export interface QbInvoiceSnapshot {
  status:          SnapshotStatus
  ambiguousReason?: string        // set when status==='ambiguous' (>1 match, PSID mismatch, …)
  invoiceId:       string
  invoiceNumber:   string | null
  totalCents:      number
  balanceCents:    number         // < totalCents ⇒ a payment has been applied
  emailStatus:     string         // 'EmailSent' etc. — informational, never a block on its own
  voided:          boolean        // already voided/zeroed in QB ⇒ idempotent no-op
  salesLines:      QbSalesLine[]
}

/** The stored linkage for the Job being removed (from the dealer scan or the retail estimate). */
export interface RemovalLinkage {
  isDealer:     boolean
  hasQbLink:    boolean           // dealer: synced scan w/ invoice #; retail: estimate has qbInvoiceId
  stockToken:   string | null     // dealer: `#<STOCK>` used to identify the exact erroneous line
  storedLineId: string | null     // dealer qb_line_id when present (extra agreement guard); else null
}

export type QbRemovalPlan =
  | { kind: 'no_qb' }                                                                    // Case A — never reached QB
  | { kind: 'idempotent_qb_done'; invoiceNumber: string | null }                        // already voided / gone
  | { kind: 'line_remove';      invoiceId: string; invoiceNumber: string | null; lineId: string } // Case B
  | { kind: 'void_standalone';  invoiceId: string; invoiceNumber: string | null }       // Case C
  | { kind: 'blocked_paid';     invoiceNumber: string | null; reason: string }          // payment activity
  | { kind: 'ambiguous';        reason: string }                                        // cannot prove → fail closed

/**
 * Does an uppercased QB line description contain the exact stock token as a WHOLE token?
 * `stockToken` looks like "#K518991". A trailing word boundary is required so "#12" can never
 * match "#123" — the single strongest identifier we have for a dealer line.
 */
export function descriptionMatchesStock(description: string, stockToken: string): boolean {
  const d = description.toUpperCase()
  const t = stockToken.toUpperCase()
  const i = d.indexOf(t)
  if (i < 0) return false
  const after = d[i + t.length]
  return after === undefined || after === ' '
}

/**
 * Decide the QuickBooks action for a removal. Pure. Order of checks is deliberate:
 *   1. no link at all                     → no_qb
 *   2. invoice vanished from QB           → idempotent_qb_done (proceed; nothing to undo)
 *   3. couldn't pin exactly one invoice   → ambiguous (fail closed)
 *   4. invoice already voided/zeroed      → idempotent_qb_done
 *   5. ANY payment applied (balance<total)→ blocked_paid (fail closed — never touch paid money)
 *   6. dealer: exactly one line matches the stock token (and any stored line-id agrees)
 *        · that line is the only sales line → void_standalone
 *        · otherwise                        → line_remove (Case B: surgical, others preserved)
 *   7. retail: standalone invoice (identity already PSID-proven upstream) → void_standalone
 */
export function decideQbRemovalPlan(link: RemovalLinkage, snap: QbInvoiceSnapshot | null): QbRemovalPlan {
  if (!link.hasQbLink || !snap) return { kind: 'no_qb' }
  if (snap.status === 'not_found') return { kind: 'idempotent_qb_done', invoiceNumber: snap.invoiceNumber }
  if (snap.status === 'ambiguous') return { kind: 'ambiguous', reason: snap.ambiguousReason ?? 'invoice_not_resolved' }
  if (snap.voided) return { kind: 'idempotent_qb_done', invoiceNumber: snap.invoiceNumber }

  // Payment activity → fail closed for EVERY path (line removal and void alike).
  if (snap.balanceCents < snap.totalCents) {
    return { kind: 'blocked_paid', invoiceNumber: snap.invoiceNumber, reason: 'payment_activity' }
  }

  if (link.isDealer) {
    if (!link.stockToken) return { kind: 'ambiguous', reason: 'no_stock_token' }
    const matches = snap.salesLines.filter((l) => descriptionMatchesStock(l.description, link.stockToken!))
    if (matches.length !== 1) return { kind: 'ambiguous', reason: `stock_token_matched_${matches.length}_lines` }
    const target = matches[0]
    if (link.storedLineId && String(link.storedLineId) !== String(target.id)) {
      return { kind: 'ambiguous', reason: 'stored_line_id_mismatch' }
    }
    // Standalone (this is the only real line) → void the invoice; else surgically remove this line.
    if (snap.salesLines.length <= 1) {
      return { kind: 'void_standalone', invoiceId: snap.invoiceId, invoiceNumber: snap.invoiceNumber }
    }
    return { kind: 'line_remove', invoiceId: snap.invoiceId, invoiceNumber: snap.invoiceNumber, lineId: target.id }
  }

  // RETAIL — one invoice per Job (identity proven by PSID in the orchestrator before we get here).
  return { kind: 'void_standalone', invoiceId: snap.invoiceId, invoiceNumber: snap.invoiceNumber }
}

/** A plan that mutates QuickBooks (must succeed before the Job may be soft-cancelled). */
export function planRequiresQbWrite(p: QbRemovalPlan): boolean {
  return p.kind === 'line_remove' || p.kind === 'void_standalone'
}

/** A plan that must REFUSE the removal outright — QB untouched AND Job left on the board. */
export function planBlocksRemoval(p: QbRemovalPlan): boolean {
  return p.kind === 'ambiguous' || p.kind === 'blocked_paid'
}

/**
 * The atomicity rule in one place: soft-cancel the Job ONLY when QuickBooks is (or already was)
 * in the desired state — no link, already-done, or a write that we confirmed succeeded. A blocked
 * plan, or a required write that failed/was not confirmed, must NEVER soft-cancel (so Pitt Stop
 * and QB can't silently disagree).
 */
export function shouldSoftCancel(p: QbRemovalPlan, qbWriteOk: boolean | undefined): boolean {
  if (planBlocksRemoval(p)) return false
  if (planRequiresQbWrite(p)) return qbWriteOk === true
  return true
}
