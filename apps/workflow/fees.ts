/**
 * P-A fee engine — pure and deterministic. Fees are explicit generated line items
 * (type='fee'), separate from tax, computed from a supplied eligible basis so the
 * basis rule can change later (P-B) without redesigning this. Shop supplies is a
 * capped percentage. Card processing is supported but disabled by default. Nothing
 * here reads settings or the DB — callers pass a resolved FeeConfig + basis.
 */
import { lineAmountCents } from './estimate'

export type FeeCode = 'shop_supplies' | 'card_fee'

export interface FeeConfig {
  shopSuppliesEnabled: boolean
  shopSuppliesBps: number
  shopSuppliesCapCents: number
  cardFeeEnabled: boolean
  cardFeeBps: number
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

/** Card processing = basis × bps (no cap in P-A). */
export function computeCardFee(basisCents: number, bps: number): number {
  return Math.max(0, Math.round((Math.max(0, basisCents) * (Number.isFinite(bps) ? bps : 0)) / 10_000))
}

/**
 * The fee lines that SHOULD exist for this basis under the given config. Only enabled
 * fees with a positive amount are returned; anything absent here gets removed by the
 * reconciler (so disabling a fee, or a zero basis, deletes its line).
 */
export function computeFees(basisCents: number, cfg: FeeConfig): DesiredFee[] {
  const out: DesiredFee[] = []
  if (cfg.shopSuppliesEnabled) {
    const cents = computeShopSupplies(basisCents, cfg.shopSuppliesBps, cfg.shopSuppliesCapCents)
    if (cents > 0) out.push({ feeCode: 'shop_supplies', name: `Shop supplies (${feePercentLabel(cfg.shopSuppliesBps)})`, priceCents: cents })
  }
  if (cfg.cardFeeEnabled) {
    const cents = computeCardFee(basisCents, cfg.cardFeeBps)
    if (cents > 0) out.push({ feeCode: 'card_fee', name: `Card processing (${feePercentLabel(cfg.cardFeeBps)})`, priceCents: cents })
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
