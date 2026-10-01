/**
 * Canonical formatting helpers — ONE source of truth for money, dates and
 * numbers across the app. Previously each page defined its own money()/big()/
 * dollars() with DIFFERENT input units (cents vs dollars), which is a 100×-error
 * risk. Names here make the unit explicit:
 *
 *   money(cents)     → "$1,234.56"   (exact, two decimals)   — tables, ledgers
 *   bigMoney(cents)  → "$1,235"      (rounded, no decimals)  — KPIs, headlines
 *   moneyFromDollars(dollars) → "$1,234.56"                  — QuickBooks P&L (dollars)
 *
 * All three render "—" for null/undefined and use a real Unicode minus (−).
 */

type Num = number | null | undefined

const MINUS = '−' // − (typographic minus, not hyphen)

/** Exact currency from integer cents: `$1,234.56`. Negative → `−$1,234.56`. */
export function money(cents: Num): string {
  if (cents == null || !Number.isFinite(cents)) return '—'
  const neg = cents < 0
  const s = (Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${neg ? MINUS : ''}$${s}`
}

/** Rounded whole-dollar currency from cents: `$1,235`. For KPIs/headlines. */
export function bigMoney(cents: Num): string {
  if (cents == null || !Number.isFinite(cents)) return '—'
  const neg = cents < 0
  const s = Math.abs(Math.round(cents / 100)).toLocaleString('en-US')
  return `${neg ? MINUS : ''}$${s}`
}

/** Currency from a DOLLARS value (e.g. QuickBooks P&L already in dollars). */
export function moneyFromDollars(dollars: Num): string {
  if (dollars == null || !Number.isFinite(dollars)) return '—'
  const neg = dollars < 0
  const s = Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${neg ? MINUS : ''}$${s}`
}

/** Plain integer with thousands separators: `1,234`. */
export function count(n: Num): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

/** Percentage with one decimal: `12.3%`. Pass the value as a percent (12.3). */
export function percent(p: Num, digits = 1): string {
  if (p == null || !Number.isFinite(p)) return '—'
  return `${p.toFixed(digits)}%`
}

/**
 * Short friendly date from a `YYYY-MM-DD` string: `Sep 20`. Parsed at noon UTC
 * so a date-only string never slips to the previous day in a western timezone.
 */
export function shortDate(date: string | null | undefined): string {
  if (!date) return '—'
  const d = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Friendly date with year: `Sep 20, 2026`. */
export function longDate(date: string | null | undefined): string {
  if (!date) return '—'
  const d = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
