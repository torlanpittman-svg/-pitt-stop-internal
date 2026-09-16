import { describe, it, expect } from 'vitest'
import { parseQuery } from './normalize'
import { matchTier, compareResults, TIER_EXACT, TIER_PREFIX, TIER_PARTIAL, TIER_NONE } from './rank'
import type { SearchResult } from './types'

const p = (s: string) => parseQuery(s).parsed!

describe('matchTier — identifiers', () => {
  it('exact customer name → tier 0', () => {
    expect(matchTier(p('Honey Badger'), { text: ['Honey Badger'] })).toBe(TIER_EXACT)
  })

  it('mid-word substring of a name → tier 2 (partial)', () => {
    // "ney" is inside "Honey" but not at a word boundary → partial, not prefix.
    expect(matchTier(p('ney'), { text: ['Honey Badger'] })).toBe(TIER_PARTIAL)
  })

  it('word-start of a later name token → tier 1 (prefix)', () => {
    expect(matchTier(p('badg'), { text: ['Honey Badger'] })).toBe(TIER_PREFIX)
  })

  it('name prefix → tier 1', () => {
    expect(matchTier(p('honey'), { text: ['Honey Badger'] })).toBe(TIER_PREFIX)
  })

  it('normalized full phone match (punctuation ignored) → tier 0', () => {
    expect(matchTier(p('2545551234'), { ids: ['(254) 555-1234'] })).toBe(TIER_EXACT)
  })

  it('mid-number substring of a phone → tier 2 (partial)', () => {
    expect(matchTier(p('555'), { ids: ['(254) 555-1234'] })).toBe(TIER_PARTIAL)
  })

  it('trailing digits of a phone (significant part) → tier 1 (prefix)', () => {
    expect(matchTier(p('5551234'), { ids: ['(254) 555-1234'] })).toBe(TIER_PREFIX)
  })

  it('full VIN match → tier 0', () => {
    expect(matchTier(p('1HGCM82633A001234'), { ids: ['1HGCM82633A001234'] })).toBe(TIER_EXACT)
    // case-insensitive
    expect(matchTier(p('1hgcm82633a001234'), { ids: ['1HGCM82633A001234'] })).toBe(TIER_EXACT)
  })

  it('VIN last-four → prefix tier (better than plain partial)', () => {
    expect(matchTier(p('1234'), { ids: ['1HGCM82633A001234'] })).toBe(TIER_PREFIX)
  })

  it('license-plate normalization (ignore hyphen) → exact', () => {
    expect(matchTier(p('ABC123'), { ids: ['ABC-123'] })).toBe(TIER_EXACT)
  })

  it('stock-number exact → tier 0', () => {
    expect(matchTier(p('PS-1234'), { ids: ['PS-1234'] })).toBe(TIER_EXACT)
  })

  it('order/invoice number exact → tier 0', () => {
    expect(matchTier(p('1042'), { ids: ['1042'] })).toBe(TIER_EXACT)
  })

  it('service word gets a word-boundary prefix tier inside a description', () => {
    expect(matchTier(p('ceramic'), { text: ['Full ceramic coating'] })).toBe(TIER_PREFIX)
  })

  it('no match → TIER_NONE (dropped by the pipeline)', () => {
    expect(matchTier(p('zzz'), { ids: ['1042'], text: ['Honey'] })).toBe(TIER_NONE)
  })
})

describe('compareResults — deterministic ordering', () => {
  const mk = (tier: number, sortKey: string, title: string): SearchResult => ({
    category: 'jobs', id: title, href: null, title, subtitle: '', tier, sortKey,
  })
  it('sorts exact before prefix before partial', () => {
    const arr = [mk(2, 'a', 'p'), mk(0, 'a', 'e'), mk(1, 'a', 'x')]
    arr.sort(compareResults)
    expect(arr.map((r) => r.tier)).toEqual([0, 1, 2])
  })
  it('within a tier, higher sortKey (recency) first, then title', () => {
    const arr = [mk(0, '2024-01-01', 'b'), mk(0, '2024-06-01', 'a'), mk(0, '2024-06-01', 'z')]
    arr.sort(compareResults)
    expect(arr.map((r) => r.title)).toEqual(['a', 'z', 'b'])
  })
})
