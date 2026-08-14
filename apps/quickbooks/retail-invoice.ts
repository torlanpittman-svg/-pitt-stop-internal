/**
 * Retail QuickBooks invoice payload builder — PURE + centralized (P-D3.1).
 *
 * Builds QB lines from the AUTHORITATIVE Pitt Stop Invoice Draft. It NEVER recalculates
 * pricing: it receives already-authoritative amounts and asserts the invariant
 *   Σ(line amounts) === expectedTotalCents (the draft total)
 * throwing RetailTotalMismatchError if they differ (e.g. a taxable job whose total
 * includes tax — retail detailing is non-taxable so this must match exactly).
 *
 * Convention (from historical AutoLeap/QB invoices): generic items only —
 * "Labor" for work (one line for a flat Job, one per service when itemized) and
 * "Fees" for shop supplies / payment charge. Waived fees are simply omitted. Vehicle
 * goes in the first work line's header + the PrivateNote (with the PSID recovery tag).
 * No per-service QB Product/Service is ever created. This module has NO QB/DB calls.
 */
import { firstLineDescription, buildPrivateNote, type InvoiceVehicle, type RetailFormatConfig, DEFAULT_RETAIL_FORMAT } from './retail-format'

export type RetailItemKind = 'labor' | 'fees'
export interface RetailLine { itemKind: RetailItemKind; description: string; amountCents: number }
export interface RetailPayload { lines: RetailLine[]; privateNote: string; totalCents: number }

export class RetailTotalMismatchError extends Error {
  constructor(public readonly sumCents: number, public readonly expectedCents: number) {
    super(`Retail QB line sum ${sumCents}¢ != Pitt Stop draft total ${expectedCents}¢ — refusing to build a mismatched invoice.`)
    this.name = 'RetailTotalMismatchError'
  }
}

export interface BuildRetailPayloadInput {
  estimateId: string
  vehicle: InvoiceVehicle
  /** Work lines: 1 for a flat Job (description = services performed), N for itemized. */
  workLines: { description: string; amountCents: number }[]
  /** Fee amounts already reflecting waivers (0 → line omitted). */
  shopSuppliesCents: number
  paymentChargeCents: number
  /** Customer-facing labels (configurable — never hard-coded). */
  paymentLabel: string
  shopSuppliesLabel?: string
  /** The authoritative Pitt Stop draft total — the invariant target. */
  expectedTotalCents: number
  config?: RetailFormatConfig
}

export function buildRetailPayload(input: BuildRetailPayloadInput): RetailPayload {
  const cfg = input.config ?? DEFAULT_RETAIL_FORMAT
  const lines: RetailLine[] = []

  input.workLines.forEach((w, i) => {
    lines.push({
      itemKind: 'labor',
      // First work line carries the vehicle header (Year Make Model / VIN).
      description: i === 0 ? firstLineDescription(input.vehicle, w.description, cfg) : (w.description ?? '').trim(),
      amountCents: Math.round(w.amountCents),
    })
  })

  if (input.shopSuppliesCents > 0) {
    lines.push({ itemKind: 'fees', description: input.shopSuppliesLabel?.trim() || 'Shop supplies', amountCents: Math.round(input.shopSuppliesCents) })
  }
  if (input.paymentChargeCents > 0) {
    lines.push({ itemKind: 'fees', description: input.paymentLabel.trim(), amountCents: Math.round(input.paymentChargeCents) })
  }

  const sumCents = lines.reduce((s, l) => s + l.amountCents, 0)
  if (sumCents !== Math.round(input.expectedTotalCents)) {
    throw new RetailTotalMismatchError(sumCents, Math.round(input.expectedTotalCents))
  }

  return { lines, privateNote: buildPrivateNote(input.estimateId, input.vehicle, undefined, cfg), totalCents: Math.round(input.expectedTotalCents) }
}
