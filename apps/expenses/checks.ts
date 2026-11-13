/**
 * Receipt sanity checks — PURE (client-safe). These produce WARNINGS for a human to look at; they never
 * change a value, never block a save on their own, and never merge or delete anything.
 */
import { isBusinessDate } from './types'

const DAY_MS = 86_400_000
const toUtc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** A receipt older than this is unusual enough to confirm (most are captured the day of purchase). */
export const OLD_RECEIPT_DAYS = 60

export interface DateWarning {
  kind: 'future' | 'year_misread' | 'old'
  message: string
  suggestion: string | null   // a likely-intended date (same month/day, plausible year), when there is one
}

/**
 * Is a receipt date questionable relative to today? A scanned year is the classic misread ("2026" → "2020"):
 * if moving the SAME month/day into this year or last year lands within the normal capture window, say so and
 * offer that date. Otherwise an old or future date is just flagged. null = nothing to question.
 * `today` is a plain YYYY-MM-DD business date (the caller supplies it; no timezone math here).
 */
export function receiptDateWarning(receiptDate: string | null | undefined, today: string): DateWarning | null {
  if (!isBusinessDate(receiptDate) || !isBusinessDate(today)) return null
  const d = toUtc(receiptDate), t = toUtc(today)
  const ageDays = Math.round((t - d) / DAY_MS)
  if (ageDays >= -1 && ageDays <= OLD_RECEIPT_DAYS) return null
  // Would the same month/day in a nearby year be a normal, recent date?
  const ty = +today.slice(0, 4)
  let suggestion: string | null = null
  for (const y of [ty, ty - 1]) {
    const candidate: string = `${y}${receiptDate.slice(4)}`
    if (candidate === receiptDate || !isBusinessDate(candidate)) continue
    const age = Math.round((t - toUtc(candidate)) / DAY_MS)
    if (age >= 0 && age <= OLD_RECEIPT_DAYS && iso(toUtc(candidate)) === candidate) { suggestion = candidate; break }
  }
  if (suggestion) {
    return { kind: 'year_misread', suggestion, message: `The date reads ${receiptDate} — the year may have been misread. Did you mean ${suggestion}?` }
  }
  if (ageDays < -1) return { kind: 'future', suggestion: null, message: `The date ${receiptDate} is in the future — check it.` }
  return { kind: 'old', suggestion: null, message: `The date ${receiptDate} is more than ${OLD_RECEIPT_DAYS} days ago — check it is right.` }
}

/**
 * Do the printed components add up to the total? Shipping and tax are PARTS of the total (counted once,
 * inside it) — this only flags a document whose subtotal + tax + shipping disagrees with its total, which
 * usually means one of them was misread. null when there is not enough to check.
 */
export function amountsWarning(a: { subtotalCents?: number | null; taxCents?: number | null; shippingCents?: number | null; totalCents?: number | null }): string | null {
  if (a.subtotalCents == null || a.totalCents == null) return null
  const sum = a.subtotalCents + (a.taxCents ?? 0) + (a.shippingCents ?? 0)
  if (sum === a.totalCents) return null
  const f = (c: number) => `$${(c / 100).toFixed(2)}`
  return `Subtotal + tax + shipping is ${f(sum)}, but the total reads ${f(a.totalCents)} — check the amounts.`
}

// ── Likely-duplicate evidence (surfaced for a human; NEVER auto-merged) ────────────────────────────────
export interface PurchaseFacts {
  vendor?: string | null; receiptDate?: string | null; totalCents?: number | null
  invoiceNumber?: string | null; orderNumber?: string | null
}
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
/** Vendor names match loosely: "Tesla Inc." ≈ "TESLA, INC" ≈ "Tesla". Empty never matches. */
export function sameVendor(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a).replace(/(inc|llc|co|corp|company|ltd)$/, ''), y = norm(b).replace(/(inc|llc|co|corp|company|ltd)$/, '')
  if (!x || !y) return false
  return x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y))
}

export type DuplicateStrength = 'likely' | 'possible' | 'none'
export interface DuplicateEvidence { strength: DuplicateStrength; reasons: string[] }

/**
 * Compare two purchases. 'likely' needs a document identifier in common (same vendor + invoice number, or the
 * same order number) or the same vendor + date + total. 'possible' = same vendor + total within 3 days (a
 * receipt and an emailed invoice for one purchase often differ by a day). An equal total alone is never
 * evidence. This only DESCRIBES the overlap — the caller shows it; nothing is merged.
 */
export function duplicateEvidence(a: PurchaseFacts, b: PurchaseFacts): DuplicateEvidence {
  const reasons: string[] = []
  const vendor = sameVendor(a.vendor, b.vendor)
  const inv = !!norm(a.invoiceNumber) && norm(a.invoiceNumber) === norm(b.invoiceNumber)
  const ord = !!norm(a.orderNumber) && norm(a.orderNumber) === norm(b.orderNumber)
  const total = a.totalCents != null && a.totalCents > 0 && a.totalCents === b.totalCents
  const bothDated = isBusinessDate(a.receiptDate) && isBusinessDate(b.receiptDate)
  const dayGap = bothDated ? Math.abs(Math.round((toUtc(a.receiptDate as string) - toUtc(b.receiptDate as string)) / DAY_MS)) : null
  if (vendor) reasons.push('same vendor')
  if (inv) reasons.push('same invoice number')
  if (ord) reasons.push('same order number')
  if (total) reasons.push('same total')
  if (dayGap === 0) reasons.push('same date')
  else if (dayGap != null && dayGap <= 3) reasons.push(`${dayGap} day${dayGap === 1 ? '' : 's'} apart`)
  let strength: DuplicateStrength = 'none'
  if ((vendor && inv) || ord || (vendor && total && dayGap === 0)) strength = 'likely'
  else if (vendor && total && dayGap != null && dayGap <= 3) strength = 'possible'
  return { strength, reasons: strength === 'none' ? [] : reasons }
}

/** Today's plain business date (YYYY-MM-DD) in the shop's timezone — the reference for receiptDateWarning. */
export function todayBusinessDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
