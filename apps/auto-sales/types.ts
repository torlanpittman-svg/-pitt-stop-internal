/**
 * Auto-Sales B0 — vocabulary for the three separate classification axes + a FACTUAL (not accounting)
 * cost-relevance helper used only to aggregate "money spent on a specific vehicle." Accounting
 * treatment is deliberately NOT derived here — it defaults to 'unknown_confirm' and is set later.
 */

// 1. ECONOMIC CATEGORY — what economically happened.
export const ECONOMIC_CATEGORIES = [
  'acquisition',
  'part', 'recon_labor', 'mechanic', 'bodywork', 'pdr', 'paint', 'transport',
  'title_tax', 'registration', 'auction_fee', 'buyer_fee',
  'floorplan_draw', 'floorplan_interest', 'floorplan_fee', 'curtailment', 'financing_settlement',
  'vendor_credit', 'return', 'refund',
  'sale', 'trade_allowance', 'commission', 'deposit',
  'adjustment', 'other',
] as const
export type EconomicCategory = (typeof ECONOMIC_CATEGORIES)[number]

// 2. CASH-FLOW CATEGORY — how cash behaved.
export const CASHFLOW_CATEGORIES = [
  'cash_outflow', 'cash_inflow', 'financing_inflow', 'financing_repayment', 'non_cash', 'transfer', 'pending',
] as const
export type CashflowCategory = (typeof CASHFLOW_CATEGORIES)[number]

// 3. ACCOUNTING TREATMENT — how the accountant/bookkeeping layer should treat it. Defaults to
// 'unknown_confirm'; a separate treatment layer (B6, accountant-configurable) sets the rest.
export const ACCOUNTING_TREATMENTS = [
  'unknown_confirm', 'inventory_capitalized', 'period_expense', 'liability_reduction',
  'revenue', 'cogs', 'equity', 'contra_cost', 'financing',
] as const
export type AccountingTreatment = (typeof ACCOUNTING_TREATMENTS)[number]

export type InventoryStatus = 'sourcing' | 'acquired' | 'in_recon' | 'listed' | 'sale_pending' | 'sold' | 'delivered' | 'wholesaled' | 'unwound'
export type FinancialCompleteness = 'complete' | 'partially_reconstructed' | 'historical_incomplete' | 'needs_review'
export type EventStatus = 'proposed' | 'unverified' | 'verified' | 'reconciled' | 'void'
export type RefundStatus = 'expected' | 'pending' | 'settled'

// Return/refund/credit kinds (UI). Cash/card refunds carry a settlement lifecycle; vendor/store
// credits and exchanges reduce economic cost but are NOT bank cash. `econ` = ledger economic_category.
export const REFUND_KINDS = [
  { kind: 'cash_refund',   label: 'Cash refund',   econ: 'refund' as EconomicCategory,        method: 'cash',         cash: true },
  { kind: 'card_refund',   label: 'Card refund',   econ: 'refund' as EconomicCategory,        method: 'card',         cash: true },
  { kind: 'vendor_credit', label: 'Vendor credit', econ: 'vendor_credit' as EconomicCategory, method: 'vendor_credit', cash: false },
  { kind: 'store_credit',  label: 'Store credit',  econ: 'vendor_credit' as EconomicCategory, method: 'store_credit',  cash: false },
  { kind: 'exchange',      label: 'Exchange (return leg)', econ: 'return' as EconomicCategory, method: 'exchange',     cash: false },
  { kind: 'other_credit',  label: 'Other credit',  econ: 'refund' as EconomicCategory,        method: 'other',        cash: false },
] as const
export type RefundKind = (typeof REFUND_KINDS)[number]['kind']

// In-scope cash accounts (allowlist; extensible without schema change). Personal/holding excluded.
export const IN_SCOPE_ACCOUNTS = [
  { ref: '*2649', label: 'American Momentum *2649 (operating)' },
  { ref: '*5600', label: 'Extraco *5600 (auto sales)' },
  { ref: 'amex', label: 'Pitt Stop business Amex' },
  { ref: 'unknown', label: 'Unknown / not yet known' },
] as const

/** Sensible DEFAULT cash-flow behavior for an economic category (a fact, stored on the event and
 *  overridable at entry). Not accounting treatment. */
export function defaultCashflow(cat: EconomicCategory): CashflowCategory {
  switch (cat) {
    case 'floorplan_draw': return 'financing_inflow'
    case 'curtailment':
    case 'financing_settlement': return 'financing_repayment'
    case 'sale':
    case 'deposit': return 'cash_inflow'
    case 'refund': return 'pending'            // refund starts pending until it settles (B1/B3)
    case 'return':
    case 'vendor_credit': return 'non_cash'    // a credit/return is not cash until a refund settles
    case 'trade_allowance': return 'non_cash'
    case 'adjustment': return 'non_cash'
    default: return 'cash_outflow'             // acquisition, parts, recon, title, fees, interest, commission…
  }
}

/**
 * FACTUAL cost-relevance for computing "money spent on this specific vehicle" (NOT accounting policy).
 *  - cost_add    : increases known money-in-vehicle (acquisition, parts, recon, title, fees, interest)
 *  - cost_contra : reduces it (returns, refunds, vendor/store credits)
 *  - proceeds    : sale/deposit inflow (revenue side — never part of cost)
 *  - financing   : floor-plan draw/curtailment/payoff (cash-movement, not a vehicle cost)
 *  - informational: adjustments/other with no cost effect
 */
export function costRelevance(cat: EconomicCategory): 'cost_add' | 'cost_contra' | 'selling_cost' | 'proceeds' | 'financing' | 'informational' {
  switch (cat) {
    case 'acquisition':
    case 'part': case 'recon_labor': case 'mechanic': case 'bodywork': case 'pdr': case 'paint':
    case 'transport': case 'title_tax': case 'registration': case 'auction_fee': case 'buyer_fee':
    case 'floorplan_interest': case 'floorplan_fee':
      return 'cost_add'
    case 'commission':                       // selling cost — separate from vehicle investment
      return 'selling_cost'
    case 'return': case 'refund': case 'vendor_credit':
      return 'cost_contra'
    case 'sale': case 'deposit':
      return 'proceeds'
    case 'floorplan_draw': case 'curtailment': case 'financing_settlement': case 'trade_allowance':
      return 'financing'
    default:
      return 'informational'
  }
}

export function labelFor(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
