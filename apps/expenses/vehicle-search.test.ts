import { describe, it, expect } from 'vitest'
import { matchVehicles } from './vehicle-search'

const V = [
  { id: 'a', label: 'PS-1770 — 2017 Jeep Wrangler', stock: 'PS-1770', vin: '1C4BJWDG5HL741770', year: '2017', make: 'Jeep', model: 'Wrangler', sold: false },
  { id: 'b', label: 'PS-7302 — 2014 Toyota Camry', stock: 'PS-7302', vin: '4T1BF1FK5EU387302', year: '2014', make: 'Toyota', model: 'Camry', sold: true },
  { id: 'c', label: '2008 Toyota 4Runner', stock: null, vin: null, year: '2008', make: 'Toyota', model: '4Runner', sold: false },
]
const ids = (q: string) => matchVehicles(V, q).map((v) => v.id)

describe('matchVehicles — Receipts vehicle picker search', () => {
  it('an empty search lists the whole inventory, sold vehicles included', () => { expect(ids('')).toEqual(['a', 'b', 'c']) })
  it('finds by stock number, with or without the dash', () => { expect(ids('PS-1770')).toEqual(['a']); expect(ids('ps7302')).toEqual(['b']) })
  it('finds by full VIN or its last digits', () => { expect(ids('4T1BF1FK5EU387302')).toEqual(['b']); expect(ids('741770')).toEqual(['a']) })
  it('finds by year, make and model', () => { expect(ids('2014')).toEqual(['b']); expect(ids('toyota')).toEqual(['b', 'c']); expect(ids('wrangler')).toEqual(['a']) })
  it('every word must match (year + make narrows)', () => { expect(ids('2008 toyota')).toEqual(['c']); expect(ids('2017 toyota')).toEqual([]) })
  it('a vehicle with no VIN or stock number is still found by year/make/model', () => { expect(ids('4runner')).toEqual(['c']) })
})
