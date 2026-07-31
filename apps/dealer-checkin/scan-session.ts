/**
 * Client scan-session helpers — pure, unit-testable, no I/O.
 *
 * These encode the invariants that keep one tag scan from poisoning the next:
 * every scan starts from a fully-cleared state and carries a unique idempotency
 * key, so backing out and restarting can never reuse a previous scan's image,
 * OCR, dealer, or form values, and a repeated confirm is de-duplicable.
 */

export interface ScanFields {
  stockNumber: string
  year: string
  make: string
  model: string
  color: string
}

/** A unique idempotency key for a single scan attempt. */
export function newClientRequestId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/** Empty vehicle fields — a fresh object every call (never a shared reference). */
export function blankFields(): ScanFields {
  return { stockNumber: '', year: '', make: '', model: '', color: '' }
}

/** The complete scan-specific state, everything a single scan owns. */
export interface ScanState {
  clientRequestId: string
  fields: ScanFields
  imageUrl: string | null
  storedUrl: string | null
  imageHash: string | null
  rawOcr: unknown
  ocrValues: Record<string, unknown> | null
  vin: string | null
  selectedDealerId: string | null
  submitted: boolean
}

/**
 * A brand-new, empty scan session (used on first load and on "Start Over").
 * Nothing from a prior scan survives; a new idempotency key is minted.
 */
export function freshScanSession(): ScanState {
  return {
    clientRequestId: newClientRequestId(),
    fields: blankFields(),
    imageUrl: null,
    storedUrl: null,
    imageHash: null,
    rawOcr: null,
    ocrValues: null,
    vin: null,
    selectedDealerId: null,
    submitted: false,
  }
}

/** True when no scan-specific data is present (a clean slate). */
export function isCleanSession(s: ScanState): boolean {
  return (
    s.imageUrl === null && s.storedUrl === null && s.imageHash === null &&
    s.rawOcr === null && s.ocrValues === null && s.vin === null &&
    s.selectedDealerId === null && s.submitted === false &&
    s.fields.stockNumber === '' && s.fields.year === '' && s.fields.make === '' &&
    s.fields.model === '' && s.fields.color === ''
  )
}
