/**
 * Cross-source purchase matching — PURE scoring. Produces SUGGESTIONS for a person to confirm; it never
 * decides a link. Two records are a strong candidate only with a reliable identifier in common (a check
 * number, a vendor invoice / order number) or an exact amount + close date + the same name. An equal amount
 * alone is never more than "possible", and anything ambiguous is left for review.
 */
const DAY = 86_400_000
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const isDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const words = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w))
const STOP = new Set(['check', 'debit', 'card', 'purchase', 'payment', 'withdrawal', 'point', 'sale', 'inc', 'llc', 'corp', 'company', 'store', 'auto', 'parts'])

export interface MatchSide {
  amountCents: number | null
  date: string | null
  names: (string | null | undefined)[]        // vendor / payee / bank description / memo
  refs?: (string | null | undefined)[]        // invoice #, order #, check #, doc number
  text?: (string | null | undefined)[]        // free text that may CONTAIN the other side's ref
}
export type MatchStrength = 'strong' | 'possible' | 'none'
export interface MatchScore { strength: MatchStrength; amountDeltaCents: number | null; dateDeltaDays: number | null; nameOverlap: boolean; refMatch: string | null; reasons: string[]; rank: number }

export function namesOverlap(a: MatchSide['names'], b: MatchSide['names']): boolean {
  const A = new Set(a.flatMap(words)), B = b.flatMap(words)
  if (B.some((w) => A.has(w))) return true
  const na = a.map(norm).filter((x) => x.length >= 4), nb = b.map(norm).filter((x) => x.length >= 4)
  return na.some((x) => nb.some((y) => x.includes(y) || y.includes(x)))
}
/** A reference shared by both sides: equal refs, or one side's ref (≥5 chars) appearing inside the other's text. */
export function sharedRef(a: MatchSide, b: MatchSide): string | null {
  const ra = (a.refs ?? []).map(norm).filter((r) => r.length >= 3), rb = (b.refs ?? []).map(norm).filter((r) => r.length >= 3)
  const eq = ra.find((r) => rb.includes(r))
  if (eq) return eq
  const ta = norm((a.text ?? []).join(' ')), tb = norm((b.text ?? []).join(' '))
  return ra.find((r) => r.length >= 5 && tb.includes(r)) ?? rb.find((r) => r.length >= 5 && ta.includes(r)) ?? null
}

/** Score one pair. `maxDays` bounds how far apart the two dates may be for a strong match (a check can clear weeks later). */
export function scorePair(a: MatchSide, b: MatchSide, opts: { maxDays?: number } = {}): MatchScore {
  const maxDays = opts.maxDays ?? 5
  const none: MatchScore = { strength: 'none', amountDeltaCents: null, dateDeltaDays: null, nameOverlap: false, refMatch: null, reasons: [], rank: Infinity }
  if (a.amountCents == null || b.amountCents == null || a.amountCents <= 0 || b.amountCents <= 0) return none
  const amountDeltaCents = Math.abs(a.amountCents - b.amountCents)
  const dateDeltaDays = isDate(a.date) && isDate(b.date) ? Math.abs(Math.round((utc(a.date) - utc(b.date)) / DAY)) : null
  const nameOverlap = namesOverlap(a.names, b.names)
  const refMatch = sharedRef(a, b)
  const tol = Math.max(50, Math.round(Math.max(a.amountCents, b.amountCents) * 0.01))
  const reasons: string[] = []
  if (amountDeltaCents === 0) reasons.push('same amount'); else if (amountDeltaCents <= tol) reasons.push(`amount differs by $${(amountDeltaCents / 100).toFixed(2)}`)
  if (dateDeltaDays === 0) reasons.push('same date'); else if (dateDeltaDays != null) reasons.push(`${dateDeltaDays} day${dateDeltaDays === 1 ? '' : 's'} apart`)
  if (nameOverlap) reasons.push('same name')
  if (refMatch) reasons.push('same reference number')
  let strength: MatchStrength = 'none'
  const inWindow = dateDeltaDays != null && dateDeltaDays <= maxDays
  if (amountDeltaCents === 0 && refMatch && (dateDeltaDays == null || dateDeltaDays <= Math.max(maxDays, 45))) strength = 'strong'
  else if (amountDeltaCents === 0 && inWindow && nameOverlap) strength = 'strong'
  else if (amountDeltaCents <= tol && (dateDeltaDays == null || dateDeltaDays <= Math.max(maxDays, 14)) && (nameOverlap || refMatch || amountDeltaCents === 0)) strength = 'possible'
  const rank = strength === 'none' ? Infinity : (refMatch ? 0 : 500) + amountDeltaCents * 1000 + (dateDeltaDays ?? 99) + (nameOverlap ? 0 : 50)
  return { strength, amountDeltaCents, dateDeltaDays, nameOverlap, refMatch, reasons: strength === 'none' ? [] : reasons, rank }
}

export interface Ranked<T> { item: T; score: MatchScore; ambiguous: boolean }
/**
 * Rank candidates for one record, best first. `ambiguous` is set on a strong candidate when a second strong
 * candidate is just as good (same rank band) — the caller must show it as "needs review", not as the match.
 */
export function rankMatches<T>(a: MatchSide, candidates: T[], side: (c: T) => MatchSide, opts: { maxDays?: number; limit?: number } = {}): Ranked<T>[] {
  const scored = candidates.map((item) => ({ item, score: scorePair(a, side(item), opts) })).filter((x) => x.score.strength !== 'none')
  const order = { strong: 0, possible: 1, none: 2 } as const
  scored.sort((x, y) => order[x.score.strength] - order[y.score.strength] || x.score.rank - y.score.rank)
  const strong = scored.filter((x) => x.score.strength === 'strong')
  const tie = strong.length > 1 && Math.abs(strong[0].score.rank - strong[1].score.rank) < 5
  return scored.slice(0, opts.limit ?? 3).map((x) => ({ ...x, ambiguous: tie && x.score.strength === 'strong' }))
}
