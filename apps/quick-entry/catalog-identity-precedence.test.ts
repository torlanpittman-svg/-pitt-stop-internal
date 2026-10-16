/**
 * Name/alias → catalog index precedence is deterministic: the database's row order can never decide
 * which service (and so which invoice item/description) a legacy label resolves to. Pure — no DB.
 */
import { describe, it, expect } from 'vitest'
import { buildCatalogKeyIndexDetailed } from './catalog-identity'

const cats = [
  { id: 'ozone_treatment', name: 'Ozone Treatment', active: true },
  { id: 'odor_ozone', name: 'Odor / Ozone Treatment', active: false },
  { id: 'odor_treatment', name: 'Odor Treatment', active: true },
  { id: 'cc1', name: 'Ceramic Coating — 1-Year', active: true },
  { id: 'cc3', name: 'Ceramic Coating — 3-Year', active: true },
  { id: 'complete_detail', name: 'Complete Detail', active: true },
  { id: 'dealer_cd', name: 'Dealer Complete Detail — Standard', active: true },
]
const aliases = [
  { catalogId: 'odor_ozone', alias: 'Ozone' }, { catalogId: 'odor_ozone', alias: 'Ozone Treatment' }, { catalogId: 'odor_ozone', alias: 'Odor Treatment' },
  { catalogId: 'ozone_treatment', alias: 'Ozone' },
  { catalogId: 'cc1', alias: 'Ceramic Coating' }, { catalogId: 'cc3', alias: 'Ceramic Coating' },
  { catalogId: 'dealer_cd', alias: 'Complete Detail' }, { catalogId: 'odor_ozone', alias: 'Old smell job' },
]
const shuffles = <T,>(xs: T[]): T[][] => [xs, [...xs].reverse(), [...xs.slice(3), ...xs.slice(0, 3)], [...xs].sort(() => 0).reverse()]

describe('buildCatalogKeyIndexDetailed', () => {
  it('gives the same answer for every row order', () => {
    const results = shuffles(cats).flatMap((c) => shuffles(aliases).map((a) => {
      const { index, ambiguous } = buildCatalogKeyIndexDetailed(c, a)
      return JSON.stringify({ index: [...index].sort(), ambiguous: [...ambiguous].sort() })
    }))
    expect(new Set(results).size).toBe(1)
  })
  it('"Ozone" → the active Ozone Treatment (its alias outranks the retired combined record\'s)', () => {
    expect(buildCatalogKeyIndexDetailed(cats, aliases).index.get('ozone')).toBe('ozone_treatment')
  })
  it('a service NAME outranks any alias (active name > retired name > active alias > retired alias)', () => {
    const { index } = buildCatalogKeyIndexDetailed(cats, aliases)
    expect(index.get('ozone treatment')).toBe('ozone_treatment')
    expect(index.get('odor treatment')).toBe('odor_treatment')
    expect(index.get('complete detail')).toBe('complete_detail')
    expect(index.get('odor / ozone treatment')).toBe('odor_ozone')   // a retired row's own name still identifies it (history)
    expect(index.get('old smell job')).toBe('odor_ozone')
  })
  it('a same-tier tie is AMBIGUOUS — resolves to nothing and is reported, never guessed', () => {
    const { index, ambiguous } = buildCatalogKeyIndexDetailed(cats, aliases)
    expect(index.has('ceramic coating')).toBe(false)
    expect([...ambiguous]).toEqual(['ceramic coating'])
  })
})
