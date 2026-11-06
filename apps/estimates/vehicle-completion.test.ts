/** Completing a saved vehicle from a New Estimate: fill only blank/invalid fields, keep valid data and the VIN. */
import { describe, it, expect } from 'vitest'
import { completeSavedVehicle } from './vehicle-completion'

const typed = { year: '2019', make: 'GMC', model: 'Sierra' }

describe('completeSavedVehicle', () => {
  it('saved vehicle with make/model but no year: the typed year fills it; make/model/VIN untouched', () => {
    const c = completeSavedVehicle({ year: null, make: 'GMC', model: 'Sierra', vin: '1GT12SEG4GF221480' }, { ...typed, make: 'Chevrolet', model: 'Silverado' })
    expect(c.filled).toEqual(['year'])
    expect(c.vehicle).toEqual({ year: '2019', make: 'GMC', model: 'Sierra', vin: '1GT12SEG4GF221480' })
    expect(c.old).toEqual({ year: null }); expect(c.new).toEqual({ year: '2019' })
  })
  it('missing make and model are filled from what was typed (trimmed)', () => {
    const c = completeSavedVehicle({ year: '2019', make: '', model: null, vin: null }, { year: '2020', make: ' GMC ', model: 'Sierra ' })
    expect(c.filled).toEqual(['make', 'model'])
    expect(c.vehicle).toEqual({ year: '2019', make: 'GMC', model: 'Sierra', vin: null })   // valid saved year kept over the typed 2020
  })
  it('a nonempty but invalid saved year ("19") is corrected; a valid one is never replaced', () => {
    expect(completeSavedVehicle({ year: '19', make: 'GMC', model: 'Sierra' }, typed)).toMatchObject({ filled: ['year'], old: { year: '19' }, new: { year: '2019' } })
    expect(completeSavedVehicle({ year: '2016', make: 'GMC', model: 'Sierra' }, typed).filled).toEqual([])
  })
  it('a complete saved vehicle records exactly what is on file and writes nothing', () => {
    const c = completeSavedVehicle({ year: '2016', make: 'GMC', model: 'Sierra', vin: 'V' }, { year: '2019', make: 'Ford', model: 'F-150' })
    expect(c).toEqual({ vehicle: { year: '2016', make: 'GMC', model: 'Sierra', vin: 'V' }, filled: [], old: {}, new: {} })
  })
})
