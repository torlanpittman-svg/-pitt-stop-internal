/**
 * Dealer check-in business rules — pure functions, no I/O.
 *
 * Kept dependency-free so they are trivially unit-testable and can never be
 * broken silently by a refactor elsewhere. All QB/DB orchestration lives in
 * service.ts and calls into these.
 */

export const STANDARD_RATE = 200
export const NEW_STERLING_AUTO_RATE = 125

/** First letter of a stock number, uppercased. "K518991" → "K". */
export function extractStockPrefix(stockNumber: string | null | undefined): string | null {
  if (!stockNumber) return null
  return stockNumber.match(/^\s*([A-Za-z])/)?.[1]?.toUpperCase() ?? null
}

/**
 * QB line description in the confirmed Sterling format:
 * "YEAR MAKE MODEL COLOR #STOCK". Empty segments are dropped (no blank
 * placeholders), so a stockless tag yields e.g. "VW Atlas Blue".
 */
export function formatLineDescription(v: {
  year?: string | null
  make?: string | null
  model?: string | null
  color?: string | null
  stockNumber?: string | null
}): string {
  const vehicle = [v.year, v.make, v.model].filter(Boolean).join(' ')
  const color   = v.color?.trim() || ''
  const stock   = v.stockNumber?.trim() ? `#${v.stockNumber.trim()}` : ''
  return [vehicle || 'Unknown Vehicle', color, stock].filter(Boolean).join(' ')
}

export interface PricingSignals {
  stockNumber?: string | null
  tagColor?:    string | null // 'white' | 'yellow' | 'unknown'
}

export interface PricingDecision {
  standardRate:   number
  newVehicleRate: number
  /** default rate applied when no prompt is needed — always the standard rate */
  defaultRate:    number
  /** true when a new-Sterling-Auto signal fires and the user must be prompted */
  promptRequired: boolean
  signals:        string[]
}

/**
 * Decide pricing. Never auto-selects $125 — if a "new Sterling Auto vehicle"
 * signal is present (stock prefix T, or a white tag) the caller must prompt the
 * user to choose $125 vs $200. With no signal, $200 is used silently.
 */
export function decidePricing(s: PricingSignals): PricingDecision {
  const signals: string[] = []
  if (extractStockPrefix(s.stockNumber) === 'T') signals.push('stock prefix T')
  if ((s.tagColor ?? '').toLowerCase() === 'white') signals.push('white dealer tag')
  return {
    standardRate:   STANDARD_RATE,
    newVehicleRate: NEW_STERLING_AUTO_RATE,
    defaultRate:    STANDARD_RATE,
    promptRequired: signals.length > 0,
    signals,
  }
}

/** Validate an owner/user-chosen rate against the allowed values. */
export function isAllowedRate(rate: number): boolean {
  return rate === STANDARD_RATE || rate === NEW_STERLING_AUTO_RATE || (Number.isFinite(rate) && rate > 0)
}

export interface InvoiceLike {
  id:       string
  sent:     boolean
  balance:  number
  txnDate:  string | null
}

/**
 * Pick the invoice a new line should be appended to: the most recent OPEN
 * (balance > 0) and NOT-yet-sent invoice. Returns null when a fresh invoice must
 * be created (nothing open, or the only open invoices have been sent).
 */
export function selectAppendableInvoice<T extends InvoiceLike>(invoices: T[]): T | null {
  const appendable = invoices
    .filter((i) => i.balance > 0 && !i.sent)
    .sort((a, b) => (b.txnDate ?? '').localeCompare(a.txnDate ?? ''))
  return appendable[0] ?? null
}

/** Normalize a stock number for duplicate comparison (case/space-insensitive). */
export function normalizeStock(stock: string | null | undefined): string {
  return (stock ?? '').trim().toUpperCase()
}

/** True when `stock` matches any already-present stock number. */
export function isDuplicateStock(existing: Array<string | null | undefined>, stock: string | null | undefined): boolean {
  const target = normalizeStock(stock)
  if (!target) return false
  return existing.some((e) => normalizeStock(e) === target)
}
