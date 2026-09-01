/**
 * P-A fee engine — pure and deterministic. Fees are explicit generated line items
 * (type='fee'), separate from tax, computed from a supplied eligible basis so the
 * basis rule can change later (P-B) without redesigning this. Shop supplies is a
 * capped percentage. Card processing is supported but disabled by default. Nothing
 * here reads settings or the DB — callers pass a resolved FeeConfig + basis.
 */
import { lineAmountCents, computeTotals, type Totals } from './estimate'

export type FeeCode = 'shop_supplies' | 'payment_charge'

export interface FeeConfig {
  shopSuppliesEnabled: boolean
  shopSuppliesBps: number
  shopSuppliesCapCents: number
  paymentEnabled: boolean
  paymentBps: number
  paymentLabel: string
  paymentBasis: string   // work_only | work_plus_supplies | grand_pretax
}

// Generated fee lines are non-taxable and NOT flagged for review (retail detailing is
// confirmed non-taxable, so the normal invoice carries no tax clutter). Kept separate
// from the taxable-service 'review' path used by mechanical/parts later.
export const FEE_TAX_CATEGORY = 'fee'

/** Retail vs dealer, from the Job's source/type. Dealer Jobs get NO retail charges/tax. */
export function isDealerOrder(order: { source?: string | null; serviceType?: string | null }): boolean {
  const s = (order.source ?? '').toLowerCase()
  const t = (order.serviceType ?? '').toLowerCase()
  return s === 'dealer' || s === 'dealer_checkin' || t.startsWith('dealer')
}

/** Retail source values that POSITIVELY identify a customer/retail Job (canonical source field). */
const RETAIL_SOURCES = new Set(['quick_entry', 'walk_in', 'vin_scan', 'retail'])

/**
 * Three-way, POSITIVE-identification Job kind from canonical source/type — never inferred from the
 * customer name. Dealer wins first (existing detector). Retail requires a known retail source or a
 * 'retail' serviceType. Anything else (null/legacy/unrecognized source) stays 'unknown' — we never
 * falsely label a Job retail or dealer without canonical evidence.
 */
export function orderSourceKind(order: { source?: string | null; serviceType?: string | null }): 'retail' | 'dealer' | 'unknown' {
  if (isDealerOrder(order)) return 'dealer'
  const s = (order.source ?? '').toLowerCase()
  const t = (order.serviceType ?? '').toLowerCase()
  if (RETAIL_SOURCES.has(s) || t === 'retail' || t.startsWith('retail')) return 'retail'
  return 'unknown'
}

/**
 * The config the engine actually uses for a Job. Dealer Jobs → shop supplies + payment
 * charge forced OFF (dealer billing is unchanged: work price only). Retail Jobs → global
 * settings minus this Job's manager/admin waivers.
 */
export function effectiveFeeConfig(base: FeeConfig, opts: { isDealer: boolean; waiveShopSupplies?: boolean; waivePayment?: boolean }): FeeConfig {
  if (opts.isDealer) return { ...base, shopSuppliesEnabled: false, paymentEnabled: false }
  return {
    ...base,
    shopSuppliesEnabled: base.shopSuppliesEnabled && !opts.waiveShopSupplies,
    paymentEnabled:      base.paymentEnabled && !opts.waivePayment,
  }
}

/** One fee the engine wants to exist on the estimate. */
export interface DesiredFee { feeCode: FeeCode; name: string; priceCents: number }

/** "3%" / "3.25%" from basis points. */
export function feePercentLabel(bps: number): string {
  const pct = (Number.isFinite(bps) ? bps : 0) / 100
  return `${Number.isInteger(pct) ? pct.toString() : pct.toFixed(2).replace(/\.?0+$/, '')}%`
}

/**
 * Eligible pre-tax work subtotal = sum of all NON-generated line amounts (labor,
 * parts, sublet, other real work). Excludes generated fee lines and never touches
 * tax. Keep the basis simple in P-A — no per-service-type exclusions.
 */
export function eligibleBasisCents(lines: { priceCents: number; qty: number | string; generated?: boolean }[]): number {
  let sum = 0
  for (const l of lines) if (!l.generated) sum += lineAmountCents(l.priceCents, l.qty)
  return sum
}

/** Shop supplies = min(basis × bps, cap). Basis points + cap are config, never hard-coded. */
export function computeShopSupplies(basisCents: number, bps: number, capCents: number): number {
  const raw = Math.round((Math.max(0, basisCents) * (Number.isFinite(bps) ? bps : 0)) / 10_000)
  const capped = Math.min(raw, Number.isFinite(capCents) && capCents >= 0 ? capCents : raw)
  return Math.max(0, capped)
}

/** Payment charge = basis × bps (no cap). Basis (work vs work+supplies) is config. */
export function computePaymentCharge(basisCents: number, bps: number): number {
  return Math.max(0, Math.round((Math.max(0, basisCents) * (Number.isFinite(bps) ? bps : 0)) / 10_000))
}

/**
 * The fee lines that SHOULD exist for this work basis under the given config. Shop supplies
 * is computed on the work amount; the payment charge is computed on its configured basis
 * (default work + shop supplies — e.g. 3% of $669.50 = $20.09). Only enabled fees with a
 * positive amount are returned; anything absent gets removed by the reconciler.
 */
export function computeFees(basisCents: number, cfg: FeeConfig): DesiredFee[] {
  const out: DesiredFee[] = []
  let shop = 0
  if (cfg.shopSuppliesEnabled) {
    shop = computeShopSupplies(basisCents, cfg.shopSuppliesBps, cfg.shopSuppliesCapCents)
    if (shop > 0) out.push({ feeCode: 'shop_supplies', name: `Shop supplies (${feePercentLabel(cfg.shopSuppliesBps)})`, priceCents: shop })
  }
  if (cfg.paymentEnabled) {
    const payBasis = cfg.paymentBasis === 'work_only' ? basisCents : basisCents + shop   // work_plus_supplies | grand_pretax
    const cents = computePaymentCharge(payBasis, cfg.paymentBps)
    if (cents > 0) out.push({ feeCode: 'payment_charge', name: `${cfg.paymentLabel} (${feePercentLabel(cfg.paymentBps)})`, priceCents: cents })
  }
  return out
}

/**
 * Pure reconciliation diff between the generated fee lines that exist and the ones
 * that should exist — the heart of idempotency. Guarantees exactly one line per
 * fee_code: existing codes not desired → delete; desired codes present → update;
 * desired codes absent → insert. Recomputing never adds a second line.
 */
export interface ExistingFeeLine { id: string; feeCode: FeeCode; priceCents: number; name: string }
export interface ReconcilePlan {
  toInsert: DesiredFee[]
  toUpdate: { id: string; feeCode: FeeCode; name: string; priceCents: number }[]
  toDelete: string[]   // line ids
}
// Whether an explicit-price work amount is taxable, by tax category. Default 'review'
// (and 'exempt'/labor categories) are NOT taxed and flag needs_tax_review — we never
// silently guess taxability. Parts/consumables would be taxable (used later, not P-B2).
export function taxCategoryTaxable(cat: string | null | undefined): boolean {
  return cat === 'repair_parts' || cat === 'taxable_consumable' || cat === 'remodeling'
}

export interface ExplicitTotals extends Totals {
  workPriceCents: number
  shopSuppliesCents: number
  paymentChargeCents: number
}

/**
 * explicit_pretax totals: the manager's entered amount IS the pre-fee/pre-tax work
 * subtotal. Fees are computed ON TOP via the P-A engine (shop supplies capped, card
 * fee per setting), then tax per the work's tax category. No per-service line prices
 * are fabricated — the work amount stays a single estimate-level figure. Pure: used by
 * both the review preview and recomputeEstimate so they can never drift.
 */
export function explicitPretaxTotals(
  explicitTotalCents: number,
  cfg: FeeConfig,
  taxRateBps: number,
  taxCategory: string = 'review',
): ExplicitTotals {
  const fees = computeFees(explicitTotalCents, cfg)
  const workLine = { priceCents: explicitTotalCents, qty: 1, taxable: taxCategoryTaxable(taxCategory), taxCategory }
  const feeLines = fees.map((f) => ({ priceCents: f.priceCents, qty: 1, taxable: false, taxCategory: FEE_TAX_CATEGORY }))
  const totals = computeTotals([workLine, ...feeLines], taxRateBps, 0)
  return {
    workPriceCents: explicitTotalCents,
    shopSuppliesCents: fees.find((f) => f.feeCode === 'shop_supplies')?.priceCents ?? 0,
    paymentChargeCents: fees.find((f) => f.feeCode === 'payment_charge')?.priceCents ?? 0,
    ...totals,
  }
}

export function reconcilePlan(existing: ExistingFeeLine[], desired: DesiredFee[]): ReconcilePlan {
  const byCode = new Map<FeeCode, ExistingFeeLine>()
  for (const e of existing) byCode.set(e.feeCode, e)   // one per code (DB-enforced)
  const desiredCodes = new Set(desired.map((d) => d.feeCode))
  const toInsert: DesiredFee[] = []
  const toUpdate: ReconcilePlan['toUpdate'] = []
  for (const d of desired) {
    const cur = byCode.get(d.feeCode)
    if (!cur) toInsert.push(d)
    else if (cur.priceCents !== d.priceCents || cur.name !== d.name) toUpdate.push({ id: cur.id, feeCode: d.feeCode, name: d.name, priceCents: d.priceCents })
  }
  const toDelete = existing.filter((e) => !desiredCodes.has(e.feeCode)).map((e) => e.id)
  return { toInsert, toUpdate, toDelete }
}
