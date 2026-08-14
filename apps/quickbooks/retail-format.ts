/**
 * Retail QuickBooks formatting — CENTRALIZED + configurable (P-D3.0 scaffolding).
 *
 * Encodes the historical Pitt Stop / AutoLeap convention discovered in production QB
 * invoices so later phases build lines the same way:
 *   • generic Product/Service items — "Labor" for work, "Fees" for shop supplies /
 *     payment charge, "Parts" for parts. NO per-service QB item is ever created.
 *   • the actual work lives in the line Description; the item stays generic.
 *   • vehicle Year/Make/Model (+ VIN) goes BOTH in the invoice PrivateNote and as a
 *     header on the first work line's Description.
 *
 * This module is PURE: no QuickBooks calls, no DB, no writes. It exists so vehicle /
 * label / item formatting can change in ONE place without touching invoice logic.
 * Nothing here creates or sends an invoice.
 */

/** Generic QB Products/Services used by retail (overridable from app_settings later). */
export const RETAIL_QB_ITEMS = { labor: 'Labor', fees: 'Fees', parts: 'Parts' } as const

export interface InvoiceVehicle {
  year?:  string | null
  make?:  string | null
  model?: string | null
  vin?:   string | null
}

export interface RetailFormatConfig {
  /** Item name for work lines (default "Labor"). */
  laborItem: string
  /** Item name for fee lines — shop supplies + payment charge (default "Fees"). */
  feesItem: string
  /** Include the VIN line when a VIN is present. */
  includeVin: boolean
}

export const DEFAULT_RETAIL_FORMAT: RetailFormatConfig = {
  laborItem: RETAIL_QB_ITEMS.labor,
  feesItem:  RETAIL_QB_ITEMS.fees,
  includeVin: true,
}

/** "2022 GMC Sierra\nVIN: 1XX…" — VIN line only when available. Empty string if nothing. */
export function formatInvoiceVehicle(v: InvoiceVehicle, cfg: RetailFormatConfig = DEFAULT_RETAIL_FORMAT): string {
  const ymm = [v.year, v.make, v.model].map((x) => (x ?? '').toString().trim()).filter(Boolean).join(' ')
  const lines: string[] = []
  if (ymm) lines.push(ymm)
  if (cfg.includeVin && v.vin && v.vin.trim()) lines.push(`VIN: ${v.vin.trim()}`)
  return lines.join('\n')
}

/** Idempotency tag embedded in the invoice PrivateNote so a create can be re-detected
 *  (and adopted, never duplicated) even if the DB write of qb_invoice_id was lost. */
export function psidTag(estimateId: string): string { return `PSID:${estimateId}` }

/** Recover the Pitt Stop estimate id from a PrivateNote, if present. */
export function extractPsid(note: string | null | undefined): string | null {
  const m = (note ?? '').match(/PSID:([0-9a-fA-F-]{36})/)
  return m ? m[1] : null
}

/** Invoice PrivateNote (internal): PSID tag + vehicle summary (+ optional extra). */
export function buildPrivateNote(estimateId: string, v: InvoiceVehicle, extra?: string, cfg: RetailFormatConfig = DEFAULT_RETAIL_FORMAT): string {
  const parts = [psidTag(estimateId)]
  const veh = formatInvoiceVehicle(v, cfg).replace(/\n/g, ' ')
  if (veh) parts.push(veh)
  if (extra && extra.trim()) parts.push(extra.trim())
  return parts.join(' | ')
}

/** First work line's Description = vehicle header, then the work text. */
export function firstLineDescription(v: InvoiceVehicle, work: string, cfg: RetailFormatConfig = DEFAULT_RETAIL_FORMAT): string {
  const header = formatInvoiceVehicle(v, cfg)
  const body = (work ?? '').trim()
  return header ? (body ? `${header}\n\n${body}` : header) : body
}
