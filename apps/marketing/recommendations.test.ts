import { describe, it, expect } from 'vitest'
import { buildAdRecommendations } from './recommendations'
import type { CategoryAdRollup, SearchTerm } from './ads'

const cat = (serviceCategory: string, spendCents: number, revenueCents: number, clicks = 50, conversions = 2): CategoryAdRollup =>
  ({ serviceCategory, spendCents, revenueCents, clicks, conversions, impressions: 1000 })

const term = (term: string, spendCents: number, conversions = 0, clicks = 10): SearchTerm =>
  ({ id: term, term, serviceCategory: null, spendCents, clicks, conversions, revenueCents: 0, statPeriod: '2026-W40', createdAt: new Date() })

describe('ad recommendation engine', () => {
  it('recommends shifting budget from a weak category to a strong one', () => {
    const recs = buildAdRecommendations({
      byCategory: [cat('ceramic', 41000, 430000), cat('general', 39000, 55000)],
      searchTerms: [],
    })
    const shift = recs.find((r) => r.type === 'budget_shift')
    expect(shift).toBeTruthy()
    expect(shift!.title).toContain('Ceramic')
    expect(shift!.detail).toContain('Ceramic')
  })

  it('flags a category with spend but zero attributed revenue', () => {
    const recs = buildAdRecommendations({ byCategory: [cat('interior', 20000, 0)], searchTerms: [] })
    const under = recs.find((r) => r.type === 'underperformer')
    expect(under).toBeTruthy()
    expect(under!.severity).toBe('warn')
  })

  it('recommends negative keywords only for non-customer intent with spend + no conversions', () => {
    const recs = buildAdRecommendations({
      byCategory: [],
      searchTerms: [term('diy ceramic coating', 8200), term('how to remove swirls', 6000), term('ceramic coating near me', 7000, 1)],
    })
    const negs = recs.filter((r) => r.type === 'negative_keyword').map((r) => r.title)
    expect(negs.some((t) => t.includes('diy ceramic coating'))).toBe(true)
    expect(negs.some((t) => t.includes('how to remove swirls'))).toBe(true)
    // A converting, valid-customer term is never recommended as a negative.
    expect(negs.some((t) => t.includes('near me'))).toBe(false)
  })

  it('ignores immaterial spend', () => {
    const recs = buildAdRecommendations({ byCategory: [cat('brand', 100, 0)], searchTerms: [term('diy', 100)], minSpendCents: 5000 })
    expect(recs).toHaveLength(0)
  })
})
