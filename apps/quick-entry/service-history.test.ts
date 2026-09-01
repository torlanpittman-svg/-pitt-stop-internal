import { describe, it, expect } from 'vitest'
import { normalizeService, familyKey, robustPrice, searchServiceHistory, type HistoryEntry } from './service-history'

const H = (name: string, priceCents: number | null = null): HistoryEntry => ({ name, priceCents })

describe('familyKey collapses suffix/word-order variants of the SAME phrase', () => {
  // PROVEN, not assumed: conditioner/conditioning/condition + word order all unify.
  it('leather conditioner / conditioning / condition leather → one family', () => {
    const k = familyKey('Leather Conditioner')
    expect(familyKey('leather conditioning')).toBe(k)
    expect(familyKey('condition leather')).toBe(k)
  })
  it('headlight restoration / restore headlights → one family (both mention restore)', () => {
    expect(familyKey('restore headlights')).toBe(familyKey('Headlight Restoration'))
  })
  // NOTE: bare "headlights" is a DIFFERENT (shorter) phrase — it does NOT share a family key with
  // "headlight restoration", and it shouldn't. The employee still gets the right suggestion because
  // SEARCH (below) matches them by similarity — that's the behavior that actually matters.
})

describe('searchServiceHistory — grounded matching', () => {
  const history: HistoryEntry[] = [
    H('Interior Detail', 30000), H('Interior Detail', 45000), H('Interior Detail', 20000),
    H('Leather Conditioning', 7500), H('Leather Conditioning', 7500),
    H('Headlight Restoration', 12000),
    H('Exterior Wash', 10000), H('Wax', 15000),
    H('Remove Smoke Odor', 30000),
  ]

  it('variant query "leather conditioner" matches the Leather Conditioning family', () => {
    const r = searchServiceHistory('leather conditioner', history)
    expect(r[0]?.familyKey).toBe(familyKey('Leather Conditioning'))
    expect(r[0]?.suggestedPriceCents).toBe(7500)
    expect(r[0]?.sampleSize).toBe(2)
    expect(r[0]?.evidenceLabel).toMatch(/2 jobs/)
  })

  it('"condition leather" (reordered) still matches', () => {
    const r = searchServiceHistory('condition leather', history)
    expect(r[0]?.familyKey).toBe(familyKey('Leather Conditioning'))
  })

  it('"headlights" matches Headlight Restoration; single price → weak, labeled once', () => {
    const r = searchServiceHistory('headlights', history)
    expect(r[0]?.familyKey).toBe(familyKey('Headlight Restoration'))
    expect(r[0]?.confidence).toBe('weak')
    expect(r[0]?.evidenceLabel).toMatch(/once/)
  })

  it('"restore headlights" (reordered) matches', () => {
    const r = searchServiceHistory('restore headlights', history)
    expect(r[0]?.familyKey).toBe(familyKey('Headlight Restoration'))
  })

  it('interior detail suggestion is the MEDIAN (outlier-resistant), not the average', () => {
    const r = searchServiceHistory('interior detail', history)
    // prices 200,300,450 → median 300 (avg would be ~316.67)
    expect(r[0]?.suggestedPriceCents).toBe(30000)
    expect(r[0]?.confidence).toBe('strong')
    expect(r[0]?.evidenceLabel).toMatch(/3 jobs/)
  })

  it('no relevant history → no match (never invents a price)', () => {
    const r = searchServiceHistory('ceramic coating', history)
    expect(r.length).toBe(0)
  })

  it('name-only history (no price) → matched but suggestedPrice null, confidence none', () => {
    const r = searchServiceHistory('clay bar', [H('Clay Bar', null), H('Clay Bar', null)])
    expect(r[0]?.suggestedPriceCents).toBeNull()
    expect(r[0]?.confidence).toBe('none')
    expect(r[0]?.evidenceLabel).toMatch(/No previous price/)
  })
})

describe('robustPrice', () => {
  it('median of odd/even sets', () => {
    expect(robustPrice([100, 200, 300])).toBe(200)
    expect(robustPrice([100, 200, 300, 400])).toBe(250)
  })
  it('resists a single wild outlier', () => {
    expect(robustPrice([7000, 7500, 8000, 90000])).toBe(7750) // median of the two middles, not dragged by 90000
  })
  it('empty / non-positive → null', () => {
    expect(robustPrice([])).toBeNull()
    expect(robustPrice([0, -5])).toBeNull()
  })
})

describe('normalizeService', () => {
  it('lowercases + strips punctuation/whitespace', () => {
    expect(normalizeService('  Leather-Conditioner!! ')).toBe('leather conditioner')
  })
})
