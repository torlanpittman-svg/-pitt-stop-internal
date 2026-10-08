/**
 * Input validation for marketing server actions. Fail-closed: a malformed enum, date, amount, id or
 * required field throws a MarketingInputError with a human-readable message instead of silently
 * writing garbage (an unparseable amount used to become 0; an unknown status used to become
 * undefined). Pure + dependency-free so it is trivially testable and reusable across every action.
 */
export class MarketingInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketingInputError'
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** A value that must be one of a known set (campaign type, status, channel, source, pillar, category). */
export function enumValue<T extends string>(raw: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(raw as T)) {
    throw new MarketingInputError(`Invalid ${label}: "${raw}". Expected one of: ${allowed.join(', ')}.`)
  }
  return raw as T
}

export function optionalEnumValue<T extends string>(raw: string | null, allowed: readonly T[], label: string): T | null {
  if (!raw) return null
  return enumValue(raw, allowed, label)
}

export function requiredText(raw: string, label: string, max = 1000): string {
  const v = raw.trim()
  if (!v) throw new MarketingInputError(`${label} is required.`)
  if (v.length > max) throw new MarketingInputError(`${label} is too long (max ${max} characters).`)
  return v
}

export function optionalText(raw: string | null, label: string, max = 4000): string | null {
  if (!raw) return null
  const v = raw.trim()
  if (!v) return null
  if (v.length > max) throw new MarketingInputError(`${label} is too long (max ${max} characters).`)
  return v
}

/** A calendar date in YYYY-MM-DD → a real UTC Date (rejects "2026-13-40" etc.). */
export function ymdDate(raw: string, label: string): Date {
  if (!YMD_RE.test(raw)) throw new MarketingInputError(`${label} must be a valid date (YYYY-MM-DD).`)
  const [y, m, d] = raw.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new MarketingInputError(`${label} is not a real date.`)
  }
  return dt
}

export function optionalYmdDate(raw: string | null, label: string): Date | null {
  if (!raw || !raw.trim()) return null
  return ymdDate(raw, label)
}

// Integer columns are Postgres int4 — cents/counts must fit, so reject anything above int32 max.
const INT32_MAX = 2_147_483_647

/**
 * A dollar amount → non-negative integer cents. STRICT: only an optional leading `$` and surrounding
 * whitespace are tolerated; the remainder must be `digits[.digits(1–2)]` with no letters, commas
 * (grouping), signs, exponents, or extra dots (`1abc`, `1,000`, `1.2.3`, `1e3`, `-5` all rejected).
 * Rejects values whose cents would overflow an int32 column.
 */
export function nonNegativeCents(raw: string, label: string): number {
  const cleaned = (raw ?? '').trim().replace(/^\$/, '').trim()
  if (!cleaned) throw new MarketingInputError(`${label} is required.`)
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new MarketingInputError(`${label} must be a plain non-negative dollar amount (e.g. 149 or 149.50).`)
  }
  const cents = Math.round(parseFloat(cleaned) * 100)
  if (!Number.isFinite(cents) || cents < 0) throw new MarketingInputError(`${label} must be a non-negative amount.`)
  if (cents > INT32_MAX) throw new MarketingInputError(`${label} is too large.`)
  return cents
}

export function optionalCents(raw: string | null, label: string): number | null {
  if (!raw || !raw.trim()) return null
  return nonNegativeCents(raw, label)
}

/** A non-negative whole number. STRICT digits-only (no sign/decimal/exponent/grouping/letters). Blank → 0. */
export function nonNegativeInt(raw: string, label: string, max = INT32_MAX): number {
  const cleaned = (raw ?? '').trim()
  if (!cleaned) return 0
  if (!/^\d+$/.test(cleaned)) throw new MarketingInputError(`${label} must be a non-negative whole number.`)
  const n = Number(cleaned)
  if (!Number.isInteger(n) || n < 0) throw new MarketingInputError(`${label} must be a non-negative whole number.`)
  if (n > Math.min(max, INT32_MAX)) throw new MarketingInputError(`${label} is too large.`)
  return n
}

export function uuidValue(raw: string, label: string): string {
  if (!UUID_RE.test(raw)) throw new MarketingInputError(`${label} must be a valid id.`)
  return raw
}

export function optionalUuid(raw: string | null, label: string): string | null {
  if (!raw || !raw.trim()) return null
  return uuidValue(raw.trim(), label)
}
