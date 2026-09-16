/**
 * Deterministic ranking (PURE — unit-tested).
 *
 * Rank order (spec):
 *   tier 0 — exact identifier match  (order/stock/check/invoice/VIN/phone equals the query)
 *   tier 1 — prefix match           (identifier or name starts with the query)
 *   tier 2 — partial / substring match
 * Within a tier, higher `sortKey` first (recency ISO or a stable label) then title A→Z — so results are
 * stable and understandable, never random.
 */
import type { ParsedQuery } from './normalize'
import { normalizePhone, normalizeAlnum } from './normalize'
import type { SearchResult } from './types'

/** Candidate match values for one record. */
export interface MatchFields {
  /** Exact-identifier values: order#, stock#, check#, invoice#, VIN, plate, phone. Compared normalized. */
  ids?: Array<string | null | undefined>
  /** Free-text values: names, company, service descriptions, YMM. Compared case-insensitively. */
  text?: Array<string | null | undefined>
}

const TIER_EXACT = 0
const TIER_PREFIX = 1
const TIER_PARTIAL = 2
const TIER_NONE = 99

/**
 * Compute the best match tier of a record against the parsed query. Identifiers are compared in three
 * normalized spaces (raw-lower, digits, alnum) so "1HGCM…", "1hgcm…", phone "254-honey" etc. all line
 * up; names/services are compared case-insensitively. Returns TIER_NONE (99) when nothing matches (the
 * caller filters these out — they only occur if a SQL match was on a field not mirrored here).
 */
export function matchTier(parsed: ParsedQuery, fields: MatchFields): number {
  const { lower, digits, alnum } = parsed
  let best = TIER_NONE

  for (const rawId of fields.ids ?? []) {
    if (!rawId) continue
    const idLower = rawId.toLowerCase()
    const idDigits = normalizePhone(rawId)
    const idAlnum = normalizeAlnum(rawId)

    // Exact in any normalized space.
    if (idLower === lower) return TIER_EXACT
    if (digits && idDigits === digits) return TIER_EXACT
    if (alnum && idAlnum === alnum) return TIER_EXACT
    // VIN/plate/stock suffix: the query is the trailing part of the identifier (e.g. last-4 VIN).
    if (alnum.length >= 4 && idAlnum.length > alnum.length && idAlnum.endsWith(alnum)) best = Math.min(best, TIER_PREFIX)

    // Prefix.
    if (idLower.startsWith(lower)) best = Math.min(best, TIER_PREFIX)
    if (digits && idDigits.startsWith(digits)) best = Math.min(best, TIER_PREFIX)
    if (alnum && idAlnum.startsWith(alnum)) best = Math.min(best, TIER_PREFIX)

    // Partial.
    if (idLower.includes(lower)) best = Math.min(best, TIER_PARTIAL)
    if (digits && idDigits.includes(digits)) best = Math.min(best, TIER_PARTIAL)
    if (alnum && idAlnum.includes(alnum)) best = Math.min(best, TIER_PARTIAL)
  }

  for (const rawText of fields.text ?? []) {
    if (!rawText) continue
    const t = rawText.toLowerCase()
    if (t === lower) best = Math.min(best, TIER_EXACT)
    else if (t.startsWith(lower)) best = Math.min(best, TIER_PREFIX)
    // Word-boundary prefix (e.g. "ceramic" matching "Full ceramic coating") ranks as prefix, not partial.
    else if (new RegExp(`\\b${escapeRegex(lower)}`).test(t)) best = Math.min(best, TIER_PREFIX)
    else if (t.includes(lower)) best = Math.min(best, TIER_PARTIAL)
  }

  return best
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Stable comparator: tier asc, then sortKey desc, then title asc. Deterministic for identical inputs. */
export function compareResults(a: SearchResult, b: SearchResult): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  const ak = a.sortKey ?? ''
  const bk = b.sortKey ?? ''
  if (ak !== bk) return ak < bk ? 1 : -1
  return a.title.localeCompare(b.title)
}

export { TIER_EXACT, TIER_PREFIX, TIER_PARTIAL, TIER_NONE }
