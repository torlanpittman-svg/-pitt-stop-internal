/**
 * Owner's final rules for rushed entry (2026-10-16): smoke or any other odor source asks which of the three
 * odor services is needed (retired "Remove Smoke Odor"-style services never come back), ceramic coating
 * is 1-Year or 3-Year by stated duration and otherwise asks, and history never re-offers retired or
 * ambiguous names. Pure — no DB.
 */
import { describe, it, expect } from 'vitest'
import { interpretEntry, odorWordingNeedsChoice, type InterpretCatalogItem } from './service-interpret'
import { isSuggestableHistoryName } from './jobs-db'

const C = (slug: string, name: string, aliases: string[] = [], role: InterpretCatalogItem['role'] = null): InterpretCatalogItem => ({ id: `id-${slug}`, slug, name, aliases, role })
const CATALOG = [
  C('ozone_treatment', 'Ozone Treatment', ['Ozone'], 'odor_ozone'),
  C('air_duct_cleaning', 'Air Duct Cleaning', [], 'odor_duct'),
  C('odor_treatment', 'Odor Treatment', [], 'odor_treatment'),
  C('ceramic_coating_1yr', 'Ceramic Coating — 1-Year', ['Ceramic Coating']),
  C('ceramic_coating_3yr', 'Ceramic Coating — 3-Year', ['Ceramic Coating']),
  C('interior_detail', 'Interior Detail'),
]
const ids = (e: string) => interpretEntry(e, CATALOG).candidates.map((c) => c.catalogId)

describe('smoke / odor sources never recreate a retired service — they ask which real service', () => {
  it.each(['Remove Smoke Odor', 'smoke smell', 'cigarette smoke', 'smoker car', 'vomit in back seat', 'remove smoke'])('"%s" → asks among the three odor services', (e) => {
    const r = interpretEntry(e, CATALOG)
    expect(r).toMatchObject({ status: 'choose', intent: 'odor' })
    expect(r.candidates.map((c) => c.catalogId)).toEqual(['id-odor_treatment', 'id-ozone_treatment', 'id-air_duct_cleaning'])
  })
  it('"Odor Treatment / Air Duct Cleaning" names two services → asks, offering exactly those two', () => {
    expect(ids('Odor Treatment / Air Duct Cleaning')).toEqual(['id-odor_treatment', 'id-air_duct_cleaning'])
  })
  it('the retired names are never resolved: "Complete Odor Treatment", "Odor / Ozone Treatment" ask', () => {
    expect(interpretEntry('Complete Odor Treatment', CATALOG).status).toBe('choose')
    expect(ids('Odor / Ozone Treatment')).toEqual(['id-odor_treatment', 'id-ozone_treatment'])
  })
  it('saved legacy lines with smoke wording need a choice before invoicing', () => {
    for (const t of ['Remove Smoke Odor', 'Smoke odor removal', 'Cigarette smoke']) expect(odorWordingNeedsChoice(t)).toBe(true)
  })
})

describe('ceramic coating — 1-Year or 3-Year, never guessed', () => {
  it('plain "ceramic coating" asks which option', () => {
    const r = interpretEntry('ceramic coating', CATALOG)
    expect(r).toMatchObject({ status: 'choose', question: 'Which ceramic coating — 1-Year or 3-Year protection?' })
    expect(r.candidates.map((c) => c.catalogId)).toEqual(['id-ceramic_coating_1yr', 'id-ceramic_coating_3yr'])
  })
  it.each([['1-Year Ceramic Coating', 'id-ceramic_coating_1yr'], ['ceramic 1 yr', 'id-ceramic_coating_1yr'], ['one year ceramic', 'id-ceramic_coating_1yr'],
    ['3-Year Ceramic Coating', 'id-ceramic_coating_3yr'], ['ceramic coating 3 year', 'id-ceramic_coating_3yr'], ['three yr ceramic', 'id-ceramic_coating_3yr'],
    ['Ceramic Coating — 3-Year', 'id-ceramic_coating_3yr']])('"%s" → %s', (e, want) => {
    expect(interpretEntry(e, CATALOG)).toMatchObject({ status: 'resolved', candidates: [{ catalogId: want }] })
  })
  it('both durations named → asks (never picks one)', () => {
    expect(interpretEntry('ceramic 1 or 3 year', CATALOG).status).toBe('choose')
  })
})

describe('Quick Entry history never re-offers retired or ambiguous work', () => {
  const ambiguous = new Set(['ceramic coating'])
  it.each(['Remove Smoke Odor', 'Odor Treatment/Air duct cleaning', 'Complete Odor Treatment', 'Odor / Ozone Treatment', 'Ozone', 'Air duct system cleaning', 'Ceramic coating'])('"%s" is not suggested', (n) => {
    expect(isSuggestableHistoryName(n, ambiguous)).toBe(false)
  })
  it.each(['Interior detail', 'Headlight restoration', 'Clay bar'])('"%s" still is', (n) => expect(isSuggestableHistoryName(n, ambiguous)).toBe(true))
})
