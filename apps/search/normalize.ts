/**
 * Query normalization + parsing (PURE — no DB, unit-tested).
 *
 * Turns raw operator input into the normalized forms every category query needs, and classifies what
 * KIND of thing the operator likely typed (phone / vin-suffix / stock / number / text) so ranking can
 * prioritise the obvious exact match. Normalization rules (from the product spec):
 *   - phone   — match with or without punctuation (compare digits only)
 *   - VIN     — case-insensitive; partial (last 4–8) supported
 *   - plate   — ignore spaces/hyphens
 *   - names / services — case-insensitive
 *   - money   — never treated as a general search key (a leading $ / trailing "dollars" is stripped)
 *
 * All comparisons are done on the parsed forms; SQL always uses PARAMETERS (drizzle sql`` templates),
 * so any punctuation — including SQL metacharacters — is treated purely as data.
 */
import { MIN_QUERY_LENGTH, MAX_QUERY_LENGTH } from './types'

export interface ParsedQuery {
  /** Original trimmed input. */
  raw: string
  /** Lowercased, whitespace-collapsed — the canonical text form for name/service matching. */
  lower: string
  /** Digits only — for phone matching and numeric identifiers (order/check/invoice #). */
  digits: string
  /** Uppercased alphanumerics only (no spaces/hyphens) — for VIN / plate / stock matching. */
  alnum: string
  /** Escaped `%…%` LIKE pattern for substring text matching (wildcards in input are literalised). */
  likeContains: string
  /** Escaped `…%` LIKE pattern for prefix matching. */
  likePrefix: string
  /** Heuristic classification driving ranking priority. */
  kind: QueryKind
}

export type QueryKind = 'phone' | 'vin' | 'stock' | 'number' | 'text'

/** Escape LIKE/ILIKE metacharacters so `%` and `_` in operator input match literally (backslash escape). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

/** Digits only. Shared with the phone-normalization convention used elsewhere in the app. */
export function normalizePhone(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

/** Uppercased alphanumerics only — VIN/plate/stock comparison form (spaces, hyphens, punctuation dropped). */
export function normalizeAlnum(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Strip a leading currency symbol / trailing "dollars" so a money-looking query isn't a search key. */
function stripMoney(s: string): string {
  return s.replace(/^\s*\$\s*/, '').replace(/\s*dollars?\s*$/i, '').trim()
}

function classify(raw: string, digits: string, alnum: string): QueryKind {
  const compact = raw.replace(/[\s()+.-]/g, '')
  // All-digits and long enough to be a phone (7+) — treat as a phone number.
  if (/^\d+$/.test(compact) && digits.length >= 7) return 'phone'
  // Stock numbers look like PS-1234 / PS1234.
  if (/^ps[-\s]?[a-z0-9]{2,}$/i.test(raw.trim())) return 'stock'
  // Short all-digit strings are most likely an order/check/invoice number.
  if (/^\d+$/.test(compact) && digits.length >= 2) return 'number'
  // 4–17 alphanumerics with at least one digit → likely a VIN (full or suffix).
  if (alnum.length >= 4 && alnum.length <= 17 && /[0-9]/.test(alnum) && /^[A-Z0-9]+$/.test(alnum)) return 'vin'
  return 'text'
}

export interface ParseResult {
  ok: boolean
  /** Present when ok. */
  parsed?: ParsedQuery
  /** 'too_short' → return empty results (not an error); 'too_long' → reject 400. */
  reason?: 'too_short' | 'too_long'
}

/**
 * Parse + validate a raw query. Rejects only the abusive extreme (too long); a too-short query is a
 * normal empty state, not an error. Short EXACT identifiers (stock/number/vin-suffix) are allowed at
 * the MIN length; broad text still needs MIN characters too — both gated by the same MIN here, with the
 * kind letting the caller relax behaviour if desired.
 */
export function parseQuery(input: string): ParseResult {
  const raw = stripMoney((input ?? '').trim().replace(/\s+/g, ' '))
  if (raw.length > MAX_QUERY_LENGTH) return { ok: false, reason: 'too_long' }
  if (raw.length < MIN_QUERY_LENGTH) return { ok: false, reason: 'too_short' }

  const lower = raw.toLowerCase()
  const digits = normalizePhone(raw)
  const alnum = normalizeAlnum(raw)
  const esc = escapeLike(raw)
  return {
    ok: true,
    parsed: {
      raw,
      lower,
      digits,
      alnum,
      likeContains: `%${esc}%`,
      likePrefix: `${esc}%`,
      kind: classify(raw, digits, alnum),
    },
  }
}
