/**
 * Resolve WHICH occurrence of a service name to remove from a Job's text service list.
 *
 * Identical names can legitimately appear more than once (the add route explicitly
 * confirms duplicates before adding one), and the legacy behavior — filtering by
 * normalized name — silently removed ALL of them. The client now sends the tapped
 * row's index plus a snapshot of the list it displayed; resolution is conservative:
 * when the request is stale (the list changed, or a retried/duplicated request after
 * a successful removal) or the occurrence is ambiguous, nothing is removed and the
 * caller tells the manager to refresh. Exactly one occurrence is ever removed.
 */

export const normalizeServiceName = (s: string): string => s.trim().toLowerCase()

export interface ServiceRemovalHints {
  /** Index of the tapped row in the list the client displayed. */
  index?: number | null
  /** The full list the client displayed — a mismatch means the request is stale. */
  expectedServices?: string[] | null
}

export type ServiceRemovalResolution =
  | {
      outcome: 'remove'
      index: number
      next: string[]
      /** Which same-named occurrence this is (0-based, in list order) and how many exist —
       *  used to map the removal onto the matching billing row. */
      ordinal: number
      occurrenceCount: number
      /** No other occurrence of this (normalized) name remains. */
      lastOccurrence: boolean
    }
  | { outcome: 'not_found' }
  | { outcome: 'stale' }

export function resolveServiceRemoval(existing: string[], serviceName: string, hints: ServiceRemovalHints = {}): ServiceRemovalResolution {
  const target = normalizeServiceName(serviceName)
  if (!target) return { outcome: 'not_found' }

  // A snapshot that no longer matches the stored list means the manager was looking at
  // an outdated screen, or this is a retry of a removal that already succeeded. Removing
  // anything now could delete a line they never chose — fail closed and ask for a refresh.
  if (hints.expectedServices && !sameList(hints.expectedServices, existing)) return { outcome: 'stale' }

  const matches = existing.reduce<number[]>((acc, s, i) => (normalizeServiceName(s) === target ? [...acc, i] : acc), [])
  if (matches.length === 0) return { outcome: 'not_found' }

  let index: number
  const hinted = hints.index
  if (hinted != null && Number.isInteger(hinted) && hinted >= 0 && hinted < existing.length && normalizeServiceName(existing[hinted]) === target) {
    index = hinted
  } else if (matches.length === 1) {
    index = matches[0]
  } else {
    // Duplicates with no trustworthy index — never guess, and never remove them all.
    return { outcome: 'stale' }
  }

  const next = existing.slice(0, index).concat(existing.slice(index + 1))
  return {
    outcome: 'remove', index, next,
    ordinal: matches.indexOf(index), occurrenceCount: matches.length,
    lastOccurrence: !next.some((s) => normalizeServiceName(s) === target),
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i])
}

/**
 * Map a selected row in the DISPLAYED services list onto the RAW stored list the server
 * resolves against. The Job screen shows the classified split (part-classified labels
 * filtered out), so a displayed index is NOT a raw index: with raw
 * ['Hidden part','Wash','Wash'] displayed as ['Wash','Wash'], the second Wash is raw
 * index 2, not 1. Conservative: the same-name occurrence ordinal transfers ONLY when
 * both lists contain the same number of that name's occurrences — otherwise null, and
 * the caller fails closed (refresh) instead of silently deleting the wrong line.
 */
export function mapDisplayedIndexToRaw(displayed: string[], displayedIndex: number, raw: string[]): number | null {
  const name = displayed[displayedIndex]
  if (name === undefined) return null
  const target = normalizeServiceName(name)
  if (!target) return null
  const ordinal = displayed.slice(0, displayedIndex).filter((s) => normalizeServiceName(s) === target).length
  const displayedCount = displayed.filter((s) => normalizeServiceName(s) === target).length
  const rawMatches = raw.reduce<number[]>((acc, s, i) => (normalizeServiceName(s) === target ? [...acc, i] : acc), [])
  if (rawMatches.length !== displayedCount) return null
  return rawMatches[ordinal] ?? null
}

/**
 * Map a removed occurrence onto the job_services billing rows that carry the same
 * (normalized) title. Both legacy shapes exist in production:
 *  - one bill row per occurrence (a fresh promoteTextServices of a list that already
 *    contained duplicates inserts each occurrence, with its text index as sort_order);
 *  - one SHARED bill row for several occurrences (promoting again after a confirmed
 *    duplicate was added skips the existing title).
 * At most ONE bill row is ever deleted. When the mapping cannot be trusted (counts
 * that match neither shape, or sort_order ties that hide which row is which), the
 * caller must fail closed BEFORE writing anything.
 */
export interface BillRowRef {
  id: string
  sortOrder: number
}

export type BillRowMapping =
  | { outcome: 'none' }                 // nothing mirrored — text-only removal
  | { outcome: 'keep' }                 // shared row stays until the last occurrence goes
  | { outcome: 'delete'; id: string }   // delete exactly this row (and its attached lines)
  | { outcome: 'ambiguous' }            // mapping untrustworthy — remove nothing

export function resolveBillRowMapping(
  matchingRows: BillRowRef[],
  occurrence: { ordinal: number; occurrenceCount: number; lastOccurrence: boolean },
): BillRowMapping {
  if (matchingRows.length === 0) return { outcome: 'none' }
  if (matchingRows.length === 1) {
    return occurrence.lastOccurrence ? { outcome: 'delete', id: matchingRows[0].id } : { outcome: 'keep' }
  }
  if (matchingRows.length === occurrence.occurrenceCount) {
    const sorted = [...matchingRows].sort((a, b) => a.sortOrder - b.sortOrder)
    // Occurrence order is only trustworthy when every row has a distinct recorded position.
    if (new Set(sorted.map((r) => r.sortOrder)).size !== sorted.length) return { outcome: 'ambiguous' }
    return { outcome: 'delete', id: sorted[occurrence.ordinal].id }
  }
  return { outcome: 'ambiguous' }
}
