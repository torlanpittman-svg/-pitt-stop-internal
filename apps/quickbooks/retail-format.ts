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
  licensePlate?: string | null
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

/**
 * Invoice PrivateNote — INTERNAL only. Carries the PSID recovery tag (never customer-
 * facing). Vehicle now lives in the customer-facing CustomerMemo, NOT here.
 */
export function buildPrivateNote(estimateId: string, extra?: string): string {
  const parts = [psidTag(estimateId)]
  if (extra && extra.trim()) parts.push(extra.trim())
  return parts.join(' | ')
}

/**
 * Customer-facing note = QuickBooks CustomerMemo (shown as "Message displayed on invoice").
 * Clean vehicle block: Year Make Model / VIN / (Plate). No PSID, no internal metadata.
 */
export function buildCustomerMemo(v: InvoiceVehicle, cfg: RetailFormatConfig = DEFAULT_RETAIL_FORMAT): string {
  const lines: string[] = []
  const ymm = [v.year, v.make, v.model].map((x) => (x ?? '').toString().trim()).filter(Boolean).join(' ')
  if (ymm) lines.push(ymm)
  if (cfg.includeVin && v.vin && v.vin.trim()) lines.push(`VIN: ${v.vin.trim()}`)
  if (v.licensePlate && v.licensePlate.trim()) lines.push(`Plate: ${v.licensePlate.trim()}`)
  return lines.join('\n')
}

/**
 * Service line description. No managed description store yet → the clean fallback is the
 * service name itself (never AI-invented). Later a standard per-service description can flow
 * Estimate → Invoice Draft → QuickBooks by passing `stored` from the catalog.
 */
export function serviceDescription(serviceName: string, stored?: string | null): string {
  const s = (stored ?? '').trim()
  return s || serviceName.trim()
}

// ── Approved description format (service matching, 2026-10-16) ─────────────────────────────────
// The customer-facing line text is ALWAYS: the canonical catalog description (or the custom service
// name) + optionally the job-specific detail, joined by " — ". The detail is the user's own short
// text (location/component), cleaned to one line; nothing here is AI-generated. The estimate preview
// and the QuickBooks payload both call these, so what the manager sees is what QuickBooks receives.
export const DETAIL_MAX = 120
export const DETAIL_SEPARATOR = ' — '

/** One clean line: no control characters/newlines, collapsed spaces, bounded length. Empty → null. */
export function cleanDetail(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, DETAIL_MAX) : null
}

/** Canonical/custom base text + optional job detail in the approved format. */
export function composeLineDescription(base: string, detail?: string | null): string {
  const b = (base ?? '').trim()
  const d = cleanDetail(detail)
  if (!d) return b
  if (b.toLowerCase().includes(d.toLowerCase())) return b   // never repeat what the base already says
  return `${b}${DETAIL_SEPARATOR}${d}`
}

/** Special-order part line text: the actual part description, vehicle fitment, vendor part number. */
export function partLineDescription(p: { description: string; fitment?: string | null; partNumber?: string | null }): string {
  const parts = [cleanDetail(p.description) ?? 'Part']
  const fit = cleanDetail(p.fitment)
  if (fit) parts.push(`Fits: ${fit}`)
  const pn = cleanDetail(p.partNumber)
  if (pn) parts.push(`Part #: ${pn}`)
  return parts.join(DETAIL_SEPARATOR)
}
