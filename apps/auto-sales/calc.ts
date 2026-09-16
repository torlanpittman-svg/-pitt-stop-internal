/**
 * Auto-Sales — CANONICAL cost & sale calculation service. ONE place for the money math so the vehicle
 * folder, the sale confirmation screen and the monthly accountant report all agree to the cent. Pure +
 * client-safe (integer cents only; no floating point; no server imports) so it runs in a client sale
 * form AND on the server report.
 *
 * It deliberately keeps every component SEPARATELY STATED (taxes, fees, discounts are never folded into
 * revenue or gross profit) and labels the profit as MANAGEMENT/ESTIMATED — the accountant-approved
 * treatment layer (B6) is not yet built, so nothing here asserts GAAP/tax booking.
 */

// ── Payment methods (UI + storage vocabulary). Free-form `other` keeps a note. ──
export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'financing', label: 'Financing' },
  { value: 'mixed', label: 'Mixed' },
  { value: 'other', label: 'Other' },
] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]['value']
export function isPaymentMethod(v: string | null | undefined): v is PaymentMethod {
  return PAYMENT_METHODS.some((m) => m.value === v)
}

/**
 * The invested cost basis of a vehicle, separated into its factual components. Acquisition price and
 * acquisition-related costs (auction/buyer fees, transport, title-at-acquisition) are distinguished from
 * repair/reconditioning. `verifiedAdditionalCents` here is the NET of cost-adds and returns/credits.
 */
export interface VehicleCostBasis {
  acquisitionPriceCents: number      // amount paid to acquire the vehicle (the editable Purchase Price)
  acquisitionRelatedCents: number    // auction/buyer fees, transport, title/registration/tax at acquisition
  reconditioningCents: number        // parts, labor, mechanic, body, pdr, paint (recon/repair)
  otherCostCents: number             // any remaining cost_add (e.g. floor-plan interest/fees)
  returnsCreditsCents: number        // cost_contra (returns/refunds/credits) — reduces basis
  totalInvestedCents: number         // acquisition + related + recon + other − returns/credits
  unverifiedCents: number            // cost_adds not yet verified (shown separately, never silently zeroed)
  hasUnverified: boolean
}

// Factual grouping of an economic category for COST-BASIS bucketing (management view, not accounting
// policy). Mirrors costRelevance() in types.ts but splits cost_add into three business buckets.
export type CostBasisBucket = 'acquisition' | 'acquisition_related' | 'reconditioning' | 'other_cost' | 'contra' | 'none'
export function costBasisBucket(economicCategory: string): CostBasisBucket {
  switch (economicCategory) {
    case 'acquisition': return 'acquisition'
    case 'auction_fee': case 'buyer_fee': case 'transport': case 'title_tax': case 'registration':
      return 'acquisition_related'
    case 'part': case 'recon_labor': case 'mechanic': case 'bodywork': case 'pdr': case 'paint':
      return 'reconditioning'
    case 'floorplan_interest': case 'floorplan_fee':
      return 'other_cost'
    case 'return': case 'refund': case 'vendor_credit':
      return 'contra'
    default:
      return 'none' // sale/deposit/commission/financing/adjustment — not part of the vehicle cost basis
  }
}

/** A minimal event shape the calc consumes (works for both DB rows and the report). Amounts are cents. */
export interface CalcEvent {
  economicCategory: string
  amountCents: number
  status: string           // verified | reconciled | unverified | proposed | void
  reversesEventId?: string | null
  id?: string
}

/** Only events that count toward money math (excludes voids + reversed pairs). */
export function activeEvents<E extends CalcEvent>(events: E[]): E[] {
  const reversedTargets = new Set(events.filter((e) => e.reversesEventId).map((e) => e.reversesEventId as string))
  return events.filter((e) => e.status !== 'void' && !e.reversesEventId && !reversedTargets.has(e.id ?? ''))
}

const isVerified = (e: CalcEvent) => e.status === 'verified' || e.status === 'reconciled'

/** Canonical cost basis from a vehicle's ledger events. Verified cost-adds bucketed; returns net them
 *  down; unverified cost-adds are surfaced separately (never silently treated as $0). */
export function computeCostBasis(events: CalcEvent[]): VehicleCostBasis {
  const active = activeEvents(events)
  let acq = 0, related = 0, recon = 0, other = 0, contra = 0, unverified = 0
  for (const e of active) {
    const bucket = costBasisBucket(e.economicCategory)
    if (bucket === 'contra') { if (isVerified(e)) contra += e.amountCents; continue }
    if (bucket === 'none') continue
    if (!isVerified(e)) { unverified += e.amountCents; continue }
    if (bucket === 'acquisition') acq += e.amountCents
    else if (bucket === 'acquisition_related') related += e.amountCents
    else if (bucket === 'reconditioning') recon += e.amountCents
    else if (bucket === 'other_cost') other += e.amountCents
  }
  const totalInvested = acq + related + recon + other - contra
  return {
    acquisitionPriceCents: acq, acquisitionRelatedCents: related, reconditioningCents: recon,
    otherCostCents: other, returnsCreditsCents: contra, totalInvestedCents: totalInvested,
    unverifiedCents: unverified, hasUnverified: unverified > 0,
  }
}

// ── Sale financials (customer transaction) — every component separately stated ──
export interface SaleFinancialsInput {
  salePriceCents: number          // vehicle selling price (revenue basis; taxes/fees excluded)
  taxCents?: number               // sales tax collected from the customer (NOT revenue, NOT profit)
  docFeesCents?: number           // title/registration/document fees collected (pass-through, separate)
  otherChargesCents?: number      // other separately-stated customer charges
  discountCents?: number          // discounts/allowances that reduce the customer total
  amountReceivedCents?: number    // cash actually received to date
}
export interface SaleFinancials {
  salePriceCents: number
  taxCents: number
  docFeesCents: number
  otherChargesCents: number
  discountCents: number
  /** Total the customer owes: sale price − discount + tax + fees + other charges. */
  totalTransactionCents: number
  amountReceivedCents: number
  /** Outstanding A/R (never negative; overpayment surfaced separately as `overpaidCents`). */
  balanceRemainingCents: number
  overpaidCents: number
}
export function computeSaleFinancials(input: SaleFinancialsInput): SaleFinancials {
  const salePrice = Math.max(0, Math.round(input.salePriceCents || 0))
  const tax = Math.max(0, Math.round(input.taxCents || 0))
  const docFees = Math.max(0, Math.round(input.docFeesCents || 0))
  const otherCharges = Math.max(0, Math.round(input.otherChargesCents || 0))
  const discount = Math.max(0, Math.round(input.discountCents || 0))
  const received = Math.max(0, Math.round(input.amountReceivedCents || 0))
  const total = salePrice - discount + tax + docFees + otherCharges
  const diff = total - received
  return {
    salePriceCents: salePrice, taxCents: tax, docFeesCents: docFees, otherChargesCents: otherCharges,
    discountCents: discount, totalTransactionCents: total, amountReceivedCents: received,
    balanceRemainingCents: Math.max(0, diff), overpaidCents: diff < 0 ? -diff : 0,
  }
}

/**
 * MANAGEMENT / ESTIMATED gross profit for a vehicle sale. Canonical rule:
 *   gross = (vehicle selling price − discount) − acquisition price − acquisition-related − reconditioning − other cost + returns/credits
 * Taxes and customer fees are EXCLUDED (pass-through, separately stated). Selling costs (commission)
 * are reported separately by the caller; this figure is the vehicle margin before selling costs.
 */
export function computeEstimatedGrossProfit(saleNetOfDiscountCents: number, basis: VehicleCostBasis): number {
  return saleNetOfDiscountCents - basis.totalInvestedCents
}

/** Convenience: dollars string → integer cents (safe; returns null on non-finite). */
export function dollarsToCents(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}
