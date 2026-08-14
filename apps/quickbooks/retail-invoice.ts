/**
 * Retail QuickBooks invoice payload builder — PURE + centralized (P-D3.1 / revised).
 *
 * Builds QB lines from the AUTHORITATIVE Pitt Stop Invoice Draft. It NEVER recalculates
 * pricing: it receives already-authoritative amounts and asserts the invariant
 *   Σ(line amounts) === expectedTotalCents (the draft total)
 * throwing RetailTotalMismatchError otherwise (retail detailing is non-taxable, so this
 * must match exactly).
 *
 * Retail structure (revised): ONE line per actual service, each with its own resolved
 * Product/Service item (caller resolves item ids — catalog qb_item_ref, or generic "Labor"
 * fallback). Shop supplies + payment charge are separate "Fees" lines (waived → omitted).
 * Vehicle goes in the customer-facing CustomerMemo; the PSID recovery tag goes in the
 * internal PrivateNote. Service descriptions are clean (service name / stored description) —
 * NO vehicle text in line descriptions. This module makes NO QB/DB calls.
 */
import { buildCustomerMemo, buildPrivateNote, type InvoiceVehicle } from './retail-format'

export interface RetailWorkService { itemId: string; description: string; amountCents: number }
export interface RetailBuiltLine { itemId: string; description: string; amountCents: number }
export interface RetailPayload { lines: RetailBuiltLine[]; customerMemo: string; privateNote: string; totalCents: number }

export class RetailTotalMismatchError extends Error {
  constructor(public readonly sumCents: number, public readonly expectedCents: number) {
    super(`Retail QB line sum ${sumCents}¢ != Pitt Stop draft total ${expectedCents}¢ — refusing to build a mismatched invoice.`)
    this.name = 'RetailTotalMismatchError'
  }
}

export interface BuildRetailPayloadInput {
  estimateId: string
  vehicle: InvoiceVehicle
  /** One entry per service line (itemId resolved by the caller). Sums to the Work Total. */
  workServices: RetailWorkService[]
  /** The single generic "Fees" QB item id used for both fee lines. */
  feesItemId: string
  /** Fee amounts already reflecting waivers (0 → line omitted). */
  shopSuppliesCents: number
  paymentChargeCents: number
  /** Configurable labels (never hard-coded). */
  paymentLabel: string
  shopSuppliesLabel?: string
  /** The authoritative Pitt Stop draft total — the invariant target. */
  expectedTotalCents: number
}

export function buildRetailPayload(input: BuildRetailPayloadInput): RetailPayload {
  const lines: RetailBuiltLine[] = input.workServices.map((w) => ({
    itemId: w.itemId, description: (w.description ?? '').trim(), amountCents: Math.round(w.amountCents),
  }))

  if (input.shopSuppliesCents > 0) {
    lines.push({ itemId: input.feesItemId, description: input.shopSuppliesLabel?.trim() || 'Shop supplies', amountCents: Math.round(input.shopSuppliesCents) })
  }
  if (input.paymentChargeCents > 0) {
    lines.push({ itemId: input.feesItemId, description: input.paymentLabel.trim(), amountCents: Math.round(input.paymentChargeCents) })
  }

  const sumCents = lines.reduce((s, l) => s + l.amountCents, 0)
  if (sumCents !== Math.round(input.expectedTotalCents)) throw new RetailTotalMismatchError(sumCents, Math.round(input.expectedTotalCents))

  return {
    lines,
    customerMemo: buildCustomerMemo(input.vehicle),
    privateNote: buildPrivateNote(input.estimateId),
    totalCents: Math.round(input.expectedTotalCents),
  }
}
