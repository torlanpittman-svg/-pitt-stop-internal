import { describe, it, expect } from 'vitest'
import { norm, wordsToNumber, priceFromToken, deterministicInterpret, type CatalogService } from './interpret'

const SERVICES: CatalogService[] = [
  { catalogId: 'c1', title: 'Interior Detail', terms: ['interior detail'] },
  { catalogId: 'c2', title: 'Exterior Wash', terms: ['exterior wash'] },
  { catalogId: 'c3', title: 'Leather Conditioner', terms: ['leather conditioner'] },
  { catalogId: 'c4', title: 'Wax', terms: ['wax', 'exterior wax'] },
  { catalogId: 'c5', title: 'Polish', terms: ['polish', 'paint correction'] },
].map((s) => ({ ...s, terms: s.terms.map(norm) }))

describe('wordsToNumber (strict spelled numbers)', () => {
  it('parses pure spelled numbers', () => {
    expect(wordsToNumber('six hundred fifty')).toBe(650)
    expect(wordsToNumber('five hundred')).toBe(500)
    expect(wordsToNumber('one thousand two hundred fifty')).toBe(1250)
  })
  it('returns null when any non-number word is present (no false price)', () => {
    expect(wordsToNumber('one step polish')).toBeNull()
    expect(wordsToNumber('leather conditioner')).toBeNull()
    expect(wordsToNumber('')).toBeNull()
  })
})

describe('priceFromToken', () => {
  it('digits, $, commas, decimals', () => {
    expect(priceFromToken('650')).toBe(65000)
    expect(priceFromToken('$650')).toBe(65000)
    expect(priceFromToken('650.00')).toBe(65000)
    expect(priceFromToken('$1,250')).toBe(125000)
  })
  it('spelled numbers', () => { expect(priceFromToken('six hundred fifty')).toBe(65000) })
  it('non-price phrases → null', () => {
    expect(priceFromToken('leather conditioner')).toBeNull()
    expect(priceFromToken('interior detail')).toBeNull()
  })
})

describe('deterministicInterpret', () => {
  it('example 1: "Interior detail, exterior wash, leather conditioner, 650"', () => {
    const r = deterministicInterpret('Interior detail, exterior wash, leather conditioner, 650', SERVICES)
    expect(r.priceCents).toBe(65000)
    expect(r.recognized.map((x) => x.title)).toEqual(['Interior Detail', 'Exterior Wash', 'Leather Conditioner'])
    expect(r.unmatched).toEqual([])
  })
  it('$650 and spelled price both resolve', () => {
    expect(deterministicInterpret('interior detail, $650', SERVICES).priceCents).toBe(65000)
    expect(deterministicInterpret('interior detail, six hundred fifty', SERVICES).priceCents).toBe(65000)
  })
  it('abbreviations/notes go to unmatched (for the AI pass), price still parsed', () => {
    const r = deterministicInterpret('Interior, wash, wax, try to get the stain out of the passenger seat, 500', SERVICES)
    expect(r.priceCents).toBe(50000)
    expect(r.recognized.map((x) => x.title)).toEqual(['Wax'])   // 'wax' term matches; abbreviations don't
    expect(r.unmatched).toContain('Interior')
    expect(r.unmatched).toContain('wash')
    expect(r.unmatched).toContain('try to get the stain out of the passenger seat')
  })
  it('deduplicates recognized by normalized title', () => {
    const r = deterministicInterpret('Wax, wax, exterior wax', SERVICES)
    expect(r.recognized.map((x) => x.title)).toEqual(['Wax'])
  })
  it('unknown work is NOT hallucinated into a catalog service', () => {
    const r = deterministicInterpret('flux capacitor calibration', SERVICES)
    expect(r.recognized).toEqual([])
    expect(r.unmatched).toEqual(['flux capacitor calibration'])
  })
})
