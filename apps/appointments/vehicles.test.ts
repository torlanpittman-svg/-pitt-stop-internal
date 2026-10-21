import { beforeEach, describe, expect, it } from 'vitest'
import { clearVehicleCache, makesFor, modelsFor, TRAILER_KINDS, validateVehicle, yearsFor, OLDEST_YEAR } from './vehicles'
import { fakeVpic } from './test-vpic'

beforeEach(() => clearVehicleCache())

describe('dependent vehicle lists', () => {
  it('years run from next model year down to 1981', () => {
    const y = yearsFor(new Date('2026-10-20T12:00:00Z'))
    expect(y[0]).toBe('2027')
    expect(y[y.length - 1]).toBe(String(OLDEST_YEAR))
  })

  it('a year filters the makes', () => {
    const y2008 = makesFor('car', '2008'); const y2024 = makesFor('car', '2024')
    expect(y2008).toContain('Pontiac'); expect(y2024).not.toContain('Pontiac')
    expect(y2008).not.toContain('Rivian'); expect(y2024).toContain('Rivian')
    expect(y2024).toContain('Toyota'); expect(y2008).toContain('Toyota')
    expect(makesFor('car', '1850')).toEqual([])
    expect(makesFor('motorcycle', '2020')).toContain('Harley-Davidson')
    expect(makesFor('motorcycle', '2020')).not.toContain('Victory') // ended 2017
    expect(makesFor('trailer', '2020')).toEqual([])
  })

  it('a make filters the models (NHTSA, year-specific, deduped and sorted)', async () => {
    const r = await modelsFor('car', '2020', 'Honda', { fetchImpl: fakeVpic({ Honda: ['Civic', 'Accord', 'Civic'] }) })
    expect(r).toEqual({ models: ['Accord', 'Civic'], source: 'nhtsa' })
  })

  it('NHTSA outage: cars fall back to the curated list; motorcycles say unavailable', async () => {
    const car = await modelsFor('car', '2020', 'Honda', { fetchImpl: fakeVpic({}, { fail: true }) })
    expect(car.source).toBe('fallback'); expect(car.models).toContain('Civic')
    const moto = await modelsFor('motorcycle', '2020', 'Yamaha', { fetchImpl: fakeVpic({}, { fail: true }) })
    expect(moto).toEqual({ models: [], source: 'unavailable' })
  })

  it('trailers use a fixed list of kinds', async () => {
    expect((await modelsFor('trailer', '2020', 'Trailer')).models).toEqual(TRAILER_KINDS)
  })
})

describe('server-side vehicle validation (no arbitrary names)', () => {
  const f = fakeVpic({ Honda: ['Accord', 'Civic'], Yamaha: ['YZF-R3'] })
  it('accepts a vehicle chosen from the lists', async () => {
    expect(await validateVehicle({ type: 'car', year: '2020', make: 'Honda', model: 'Civic' }, { fetchImpl: f })).toBeNull()
    expect(await validateVehicle({ type: 'motorcycle', year: '2020', make: 'Yamaha', model: 'YZF-R3' }, { fetchImpl: f })).toBeNull()
    expect(await validateVehicle({ type: 'trailer', year: '2018', make: 'Trailer', model: 'Car hauler' })).toBeNull()
  })
  it('rejects typed-in or mismatched values', async () => {
    expect(await validateVehicle({ type: 'car', year: '2020', make: 'Honda', model: 'My Custom Car' }, { fetchImpl: f })).toMatch(/model from the list/)
    expect(await validateVehicle({ type: 'car', year: '2020', make: 'Hondaa', model: 'Civic' }, { fetchImpl: f })).toMatch(/make from the list/)
    expect(await validateVehicle({ type: 'car', year: '1975', make: 'Honda', model: 'Civic' }, { fetchImpl: f })).toMatch(/year from the list/)
    expect(await validateVehicle({ type: 'trailer', year: '2018', make: 'Trailer', model: 'Spaceship' })).toMatch(/trailer type/)
  })
  it('boats and RVs cannot be booked online', async () => {
    expect(await validateVehicle({ type: 'boat', year: '2020', make: '', model: '' })).toMatch(/by phone/)
    expect(await validateVehicle({ type: 'rv', year: '2020', make: '', model: '' })).toMatch(/by phone/)
  })
  it('when the model list cannot be checked, the booking is refused with a call-for-help message', async () => {
    expect(await validateVehicle({ type: 'motorcycle', year: '2020', make: 'Yamaha', model: 'YZF-R3' }, { fetchImpl: fakeVpic({}, { fail: true }) })).toMatch(/call the shop/)
  })
})
