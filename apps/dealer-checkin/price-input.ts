/**
 * Dealer Check-In "Price ($)" field — pure input-state helpers (no DB, safe to import client-side).
 *
 * The field keeps the operator's TEXT (not a number) so it can sit empty mid-edit. `null` means the
 * operator has not touched the field, so the suggested dealer rate applies; any string — including
 * '' — means they are editing, and the suggested rate must never be substituted for it.
 */

/** Operator's raw price text; `null` = untouched (suggested rate applies). */
export type PriceText = string | null

export type PriceResolution =
  | { ok: true; rate: number }
  | { ok: false; error: string }

/**
 * Normalize typed/pasted text to digits plus at most one '.'. Handles "$125", "1,250.50", stray
 * spaces, and a comma used as the decimal mark by comma-locale keypads ("125,5" → "125.5").
 * Never invents a value: an input with no digits becomes ''.
 */
export function sanitizePriceText(raw: string): string {
  let s = raw.replace(/[^\d.,]/g, '')
  // A lone comma followed by 0–2 digits (and no '.') is a decimal mark; otherwise commas group thousands.
  if (!s.includes('.') && /^\d*,\d{0,2}$/.test(s)) s = s.replace(',', '.')
  s = s.replace(/,/g, '')
  const dot = s.indexOf('.')
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '')
  return s
}

/** What the input shows: the operator's text if they have edited, else the suggested rate. */
export function priceFieldValue(text: PriceText, suggestedRate: number): string {
  return text === null ? String(suggestedRate) : text
}

/**
 * The rate to submit. Untouched → suggested rate. Edited → exactly what was typed, or an error;
 * an empty/invalid edit is NEVER replaced by the suggested rate.
 */
export function resolvePrice(text: PriceText, suggestedRate: number): PriceResolution {
  if (text === null) return { ok: true, rate: suggestedRate }
  const t = text.trim()
  if (t === '') return { ok: false, error: 'Enter a price before sending.' }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { ok: false, error: 'Enter the price as a number, like 125 or 125.50.' }
  if (/\.\d{3,}$/.test(t)) return { ok: false, error: 'Use dollars and cents only, like 125.50.' }
  const rate = Number(t)
  if (!Number.isFinite(rate)) return { ok: false, error: 'Enter the price as a number, like 125 or 125.50.' }
  if (rate <= 0) return { ok: false, error: 'Price must be more than $0.' }
  return { ok: true, rate }
}
