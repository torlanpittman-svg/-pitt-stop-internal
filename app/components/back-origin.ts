/**
 * Back-navigation origin resolver (pure, allowlist-only).
 *
 * A screen reachable from more than one place (e.g. Quick Entry / Dealer Check-In can be opened from
 * Smart Check-In OR direct-loaded) carries a short internal KEY in `?from=`. We resolve that key against
 * a FIXED allowlist of known Pitt Stop OS routes → a safe fallback otherwise. Because only a known key
 * ever maps to a known internal route (we never place a raw path in the URL), NO arbitrary/external
 * redirect is possible. Native/browser swipe-back is unaffected (this only chooses the visible Back link).
 */
export interface BackTarget { href: string; label: string }

// The ONLY origins a `?from=` key may resolve to. Extend deliberately; never accept a raw path.
const ORIGINS: Record<string, BackTarget> = {
  'check-in': { href: '/check-in', label: 'Check In' },
  'work-board': { href: '/work-board', label: 'Work Board' },
}

/** Resolve a `from` key to a known internal Back target, else the safe fallback. */
export function resolveBack(fromKey: string | null | undefined, fallback: BackTarget): BackTarget {
  if (fromKey && Object.prototype.hasOwnProperty.call(ORIGINS, fromKey)) return ORIGINS[fromKey]
  return fallback
}
