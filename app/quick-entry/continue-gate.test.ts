/**
 * REGRESSION: "all information appears entered, but I cannot click Continue" on New Estimate (2026-11-06).
 * The Details-step gate must (1) keep every real requirement and (2) NAME what is missing.
 */
import { describe, it, expect } from 'vitest'
import { continueBlockers, isFourDigitYear, normalizeVehicleText, savedVehicleComplete, type DetailsState } from './continue-gate'

const ok: DetailsState = { isEstimate: true, first: 'Brian', vinBusy: false, vehicleMode: 'new', pickCount: 0, year: '2019', make: 'GMC', model: 'Sierra' }
const fields = (s: Partial<DetailsState>) => continueBlockers({ ...ok, ...s }).map((b) => b.field)

describe('continueBlockers — New Estimate', () => {
  it('nothing blocks a complete form', () => {
    expect(continueBlockers(ok)).toEqual([])
  })
  it('a year with surrounding whitespace (phone keyboard suggestion) is still a valid 4-digit year', () => {
    expect(continueBlockers({ ...ok, year: '2019 ' })).toEqual([])
    expect(continueBlockers({ ...ok, year: ' 2019' })).toEqual([])
    expect(isFourDigitYear('2019 ')).toBe(true)
  })
  it('names a year that is not 4 digits, quoting what was typed', () => {
    expect(continueBlockers({ ...ok, year: '19' })).toEqual([{ field: 'year', message: 'The year must be 4 digits — "19" is not.' }])
    expect(fields({ year: '2019.' })).toEqual(['year'])
    expect(fields({ year: '' })).toEqual(['year'])
  })
  it('names each missing vehicle field and the first name, in screen order', () => {
    expect(fields({ first: '  ', year: '', make: ' ', model: '' })).toEqual(['first', 'year', 'make', 'model'])
    expect(continueBlockers({ ...ok, first: '' })[0].message).toBe("Enter the customer's first name.")
  })
  it('a saved vehicle with no year/make/model on file says so (those inputs are normally hidden)', () => {
    const b = continueBlockers({ ...ok, vehicleMode: 'existing', year: '', make: 'GMC', model: '' })
    expect(b.map((x) => x.field)).toEqual(['year', 'model'])
    expect(b[0].message).toContain('saved vehicle has no year on file')
  })
  it('a VIN read in flight blocks, and says it is still reading', () => {
    expect(continueBlockers({ ...ok, vinBusy: true })).toEqual([{ field: 'vin', message: expect.stringContaining('Still reading the VIN') }])
  })
  it('"pick" mode blocks until a saved vehicle is chosen; an empty list (restored draft) gets its own guidance', () => {
    expect(continueBlockers({ ...ok, vehicleMode: 'pick', pickCount: 2 })).toEqual([{ field: 'vehicle', message: 'Choose which saved vehicle this is, or add a new vehicle.' }])
    expect(continueBlockers({ ...ok, vehicleMode: 'pick', pickCount: 0 })[0].message).toContain('no longer available')
    // While picking, the (empty) vehicle text is not reported as missing — choosing fills it.
    expect(fields({ vehicleMode: 'pick', pickCount: 2, year: '', make: '', model: '' })).toEqual(['vehicle'])
  })
})

describe('continueBlockers — Quick Entry (job intake)', () => {
  it('does not require year/make/model (the VIN photo may fill them later)', () => {
    expect(continueBlockers({ ...ok, isEstimate: false, year: '', make: '', model: '' })).toEqual([])
  })
  it('still requires the first name and no VIN read in flight', () => {
    expect(fields({ isEstimate: false, first: '', vinBusy: true })).toEqual(['first', 'vin'])
  })
})

describe('normalizeVehicleText', () => {
  it('trims year/make/model exactly as the gate judged them, leaving other fields alone', () => {
    expect(normalizeVehicleText({ vin: '1GT12SEG4GF221480', year: '2016 ', make: ' GMC', model: 'Sierra ', color: 'Blue ' }))
      .toEqual({ vin: '1GT12SEG4GF221480', year: '2016', make: 'GMC', model: 'Sierra', color: 'Blue ' })
  })
})

describe('savedVehicleComplete — opens the saved-vehicle editor (captured at selection, not re-derived while typing)', () => {
  it('make/model on file but no year → incomplete; stays a selection-time decision so typing "2", "20", "201", "2019" cannot close the editor', () => {
    expect(savedVehicleComplete({ year: null, make: 'GMC', model: 'Sierra' })).toBe(false)
    // The screen stores the result of this call when the vehicle is chosen; it is not called per keystroke.
    for (const partial of ['2', '20', '201']) expect(savedVehicleComplete({ year: partial, make: 'GMC', model: 'Sierra' })).toBe(false)
    expect(savedVehicleComplete({ year: '2019', make: 'GMC', model: 'Sierra' })).toBe(true)
  })
  it('missing make or model → incomplete; a nonempty invalid year ("19") → incomplete so correction is offered', () => {
    expect(savedVehicleComplete({ year: '2019', make: '', model: 'Sierra' })).toBe(false)
    expect(savedVehicleComplete({ year: '2019', make: 'GMC', model: null })).toBe(false)
    expect(savedVehicleComplete({ year: '19', make: 'GMC', model: 'Sierra' })).toBe(false)
  })
})
