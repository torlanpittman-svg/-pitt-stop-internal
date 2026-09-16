/**
 * Result assembly (PURE — unit-tested).
 *
 * Takes the raw candidates each category query produced, and — deterministically — scores them
 * (rank.ts), drops anything the actor's scope disallows (authz.ts) or that didn't actually match,
 * de-dupes within a category by id, sorts (exact → prefix → partial, then recency), and enforces the
 * per-category + overall caps. No DB, no I/O, no auth lookups — those happen in service.ts / the route,
 * so this whole ranking/limiting/scoping contract is testable with plain objects.
 */
import type { ParsedQuery } from './normalize'
import { matchTier, compareResults, TIER_NONE } from './rank'
import type { MatchFields } from './rank'
import { scopeAllows, type SearchScope } from './authz'
import {
  CATEGORY_ORDER, CATEGORY_LABEL, OVERALL_LIMIT, PER_CATEGORY_LIMIT,
  type SearchCategory, type SearchResult, type SearchResponse,
} from './types'

/** A category query result before scoring: display fields + the values that decide its match tier. */
export interface RawCandidate {
  category: SearchCategory
  id: string
  href: string | null
  title: string
  subtitle: string
  meta?: string
  badge?: string
  phone?: string
  sortKey?: string
  matchFields: MatchFields
}

export interface AssembleLimits {
  perCategory?: number
  overall?: number
}

export function assembleResults(
  parsed: ParsedQuery,
  scope: SearchScope,
  candidates: RawCandidate[],
  limits: AssembleLimits = {},
): SearchResponse {
  const perCategory = limits.perCategory ?? PER_CATEGORY_LIMIT
  const overall = limits.overall ?? OVERALL_LIMIT

  // Score + scope-filter + drop non-matches, bucketed by category.
  const byCategory = new Map<SearchCategory, SearchResult[]>()
  for (const c of candidates) {
    if (!scopeAllows(scope, c.category)) continue
    const tier = matchTier(parsed, c.matchFields)
    if (tier >= TIER_NONE) continue
    const bucket = byCategory.get(c.category) ?? []
    bucket.push({
      category: c.category,
      id: c.id,
      href: c.href,
      title: c.title,
      subtitle: c.subtitle,
      meta: c.meta,
      badge: c.badge,
      phone: c.phone,
      tier,
      sortKey: c.sortKey,
    })
    byCategory.set(c.category, bucket)
  }

  let total = 0
  let truncated = false
  const groups: SearchResponse['groups'] = []

  for (const category of CATEGORY_ORDER) {
    const bucket = byCategory.get(category)
    if (!bucket || bucket.length === 0) continue

    // De-dupe by id, keeping the strongest tier for a repeated record.
    const bestById = new Map<string, SearchResult>()
    for (const r of bucket) {
      const prev = bestById.get(r.id)
      if (!prev || r.tier < prev.tier) bestById.set(r.id, r)
    }
    const sorted = [...bestById.values()].sort(compareResults)

    // Per-category cap, then the overall cap (never exceed either).
    const remaining = Math.max(0, overall - total)
    if (remaining === 0) { if (sorted.length) truncated = true; break }
    const capped = sorted.slice(0, Math.min(perCategory, remaining))
    if (sorted.length > capped.length) truncated = true

    groups.push({ category, label: CATEGORY_LABEL[category], results: capped })
    total += capped.length
  }

  return { ok: true, query: parsed.raw, groups, total, truncated }
}
