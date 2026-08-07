/**
 * Phase 3 estimate engine — pure, testable. Line-level tax treatment (NOT a
 * universal rate): parts default taxable (repair_parts), motor-vehicle repair
 * labor default non-taxable, fees/sublet require explicit selection (flagged for
 * review), every line manager-overridable. The taxable rate is configured
 * (ESTIMATE_DEFAULT_TAX_BPS) and passed in — never hard-coded here. Detailing and
 * other service types are marked for review until confirmed with the CPA.
 */
export type LineType = 'labor' | 'part' | 'fee' | 'sublet'
export type ApprovalState = 'pending' | 'approved' | 'declined' | 'deferred'
export type EstimateStatus =
  | 'draft' | 'waiting_parts' | 'ready_to_send' | 'sent'
  | 'approved' | 'partially_approved' | 'declined' | 'converted'

/** Tax categories so treatment can eventually be distinguished per the CPA matrix. */
export type TaxCategory =
  | 'repair_parts' | 'mechanical_labor' | 'taxable_consumable' | 'remodeling'
  | 'detailing' | 'collision' | 'exempt' | 'fee' | 'sublet' | 'review' | 'other'

export const TAX_CATEGORIES: TaxCategory[] = [
  'repair_parts', 'mechanical_labor', 'taxable_consumable', 'remodeling',
  'detailing', 'collision', 'exempt', 'fee', 'sublet', 'review', 'other',
]

/** V1 defaults by line type. Fees/sublet get 'review' (no universal assumption). */
export function defaultTaxForType(type: LineType): { taxable: boolean; taxCategory: TaxCategory } {
  switch (type) {
    case 'part':   return { taxable: true,  taxCategory: 'repair_parts' }
    case 'labor':  return { taxable: false, taxCategory: 'mechanical_labor' }
    case 'fee':    return { taxable: false, taxCategory: 'review' }   // require explicit selection
    case 'sublet': return { taxable: false, taxCategory: 'review' }   // require explicit selection
    default:       return { taxable: false, taxCategory: 'other' }
  }
}

export interface CalcLine { priceCents: number; qty: number | string; taxable: boolean; taxCategory?: string }
export interface Totals {
  taxableSubtotalCents: number
  nontaxableSubtotalCents: number
  taxCents: number
  totalCents: number
  needsTaxReview: boolean
}

/** amount for one line = round(price * qty). */
export function lineAmountCents(priceCents: number, qty: number | string): number {
  const q = typeof qty === 'string' ? parseFloat(qty) : qty
  return Math.round((Number.isFinite(priceCents) ? priceCents : 0) * (Number.isFinite(q) ? q : 0))
}

/** Compute the four figures the manager sees. Tax applies ONLY to taxable lines,
 *  at the passed configured rate (basis points). Discount reserved (0 in V1). */
export function computeTotals(lines: CalcLine[], taxRateBps: number, discountCents = 0): Totals {
  let taxable = 0, nontaxable = 0, needsTaxReview = false
  for (const l of lines) {
    const amt = lineAmountCents(l.priceCents, l.qty)
    if (l.taxCategory === 'review') needsTaxReview = true
    if (l.taxable) taxable += amt; else nontaxable += amt
  }
  const taxCents = Math.round((taxable * (Number.isFinite(taxRateBps) ? taxRateBps : 0)) / 10_000)
  const totalCents = taxable + nontaxable + taxCents - (discountCents || 0)
  return { taxableSubtotalCents: taxable, nontaxableSubtotalCents: nontaxable, taxCents, totalCents, needsTaxReview }
}

/** Roll per-service decisions up to an estimate status (only meaningful once sent). */
export function rollUpDecision(states: ApprovalState[], current: EstimateStatus): EstimateStatus {
  if (states.length === 0) return current
  const a = states.filter((s) => s === 'approved').length
  const d = states.filter((s) => s === 'declined').length
  if (a === states.length) return 'approved'
  if (a > 0) return 'partially_approved'
  if (d > 0) return 'declined'            // some declined, none approved
  return current                          // only deferred/pending — no final decision yet
}

/** Titles eligible to sync into the Job's employee-facing services list on Convert:
 *  approved services only, trimmed, de-duplicated (case-insensitive) against what's there. */
export function approvedTitlesToSync(existing: string[], services: { title: string; approvalState: ApprovalState }[]): string[] {
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()))
  const out: string[] = []
  for (const s of services) {
    if (s.approvalState !== 'approved') continue
    const t = s.title.trim()
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase()); out.push(t)
  }
  return out
}

// ── Config (never hard-code the rate into the engine) ────────────────────────
export function estimateEnabled(): boolean { return process.env.ESTIMATE_LAYER_ENABLED === 'true' }
export function convertSyncsServices(): boolean { return process.env.ESTIMATE_CONVERT_SYNCS_SERVICES === 'true' }
export function defaultTaxBps(): number {
  const n = parseInt(process.env.ESTIMATE_DEFAULT_TAX_BPS || '825', 10)
  return Number.isFinite(n) && n >= 0 ? n : 825
}
