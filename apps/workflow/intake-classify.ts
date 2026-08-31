/**
 * Smart Check-In classification — PURE, no I/O (unit-testable). Given evidence gathered by the intake
 * (a free client-side barcode read, the dealer-tag OCR + dealer resolution, and the VIN OCR), decide
 * whether the photo is a retail VIN, a dealer tag, or unknown.
 *
 * Priority (accuracy first): a scannable 17-char VIN barcode ⇒ RETAIL (dealer tags are handwritten and
 * carry no VIN barcode, so this can't misroute a dealer-with-VIN). Otherwise DEALER evidence (stock that
 * resolves to a configured dealer) is DECISIVE — a dealer tag may also have a VIN written on it, so
 * dealer wins over a bare VIN. Then a valid VIN ⇒ RETAIL. Anything else ⇒ UNKNOWN (never guess).
 */
export type IntakeKind = 'dealer' | 'retail' | 'unknown'

export interface DealerEvidence {
  stockNumber: string | null
  /** the dealer preview resolved a dealership WITH a QB customer mapping from the stock prefix */
  dealerResolved: boolean
}
export interface VinEvidence {
  vin: string | null
  valid: boolean
}
export interface IntakeEvidence {
  /** a valid 17-char VIN decoded from a client-side barcode (free, no AI) */
  barcodeVin?: string | null
  dealer?: DealerEvidence | null
  vin?: VinEvidence | null
}

/** Stock number shape: 1–3 letters then digits (mirrors DealerCheckInFlow STOCK_RE). */
export const STOCK_RE = /^[A-Za-z]{1,3}[- ]?\d{2,}$/
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/

export function classifyIntake(e: IntakeEvidence): IntakeKind {
  // 1. Free barcode VIN → retail (a handwritten dealer tag has no scannable VIN barcode).
  if (e.barcodeVin && VIN_RE.test(e.barcodeVin.trim().toUpperCase())) return 'retail'
  // 2. Dealer evidence is decisive (dealer wins even if a VIN is also present on the tag).
  if (e.dealer?.dealerResolved && e.dealer.stockNumber && STOCK_RE.test(e.dealer.stockNumber.trim())) return 'dealer'
  // 3. A valid VIN → retail.
  if (e.vin?.valid && e.vin.vin && VIN_RE.test(e.vin.vin.trim().toUpperCase())) return 'retail'
  // 4. Otherwise unknown — don't guess (employee chooses).
  return 'unknown'
}
