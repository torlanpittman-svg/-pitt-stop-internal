import { describe, it, expect } from 'vitest'
import { formatInvoiceVehicle, firstLineDescription, buildPrivateNote, psidTag, extractPsid, RETAIL_QB_ITEMS } from './retail-format'

const SIERRA = { year: '2022', make: 'GMC', model: 'Sierra', vin: '1GTV2TEC1234567' }

describe('retail-format (P-D3.0 scaffolding, pure)', () => {
  it('keeps the generic-item convention', () => {
    expect(RETAIL_QB_ITEMS).toEqual({ labor: 'Labor', fees: 'Fees', parts: 'Parts' })
  })

  it('formats vehicle as Year Make Model + VIN line', () => {
    expect(formatInvoiceVehicle(SIERRA)).toBe('2022 GMC Sierra\nVIN: 1GTV2TEC1234567')
  })

  it('omits the VIN line when no VIN', () => {
    expect(formatInvoiceVehicle({ year: '2020', make: 'Honda', model: 'Civic' })).toBe('2020 Honda Civic')
  })

  it('handles missing pieces gracefully', () => {
    expect(formatInvoiceVehicle({ make: 'Ford' })).toBe('Ford')
    expect(formatInvoiceVehicle({})).toBe('')
  })

  it('first line = vehicle header + blank line + work (matches spec)', () => {
    expect(firstLineDescription(SIERRA, 'Interior Detail')).toBe('2022 GMC Sierra\nVIN: 1GTV2TEC1234567\n\nInterior Detail')
  })

  it('first line with no vehicle is just the work', () => {
    expect(firstLineDescription({}, 'Interior Detail')).toBe('Interior Detail')
  })

  it('PrivateNote carries the PSID idempotency tag + vehicle', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const note = buildPrivateNote(id, SIERRA)
    expect(note.startsWith(`PSID:${id}`)).toBe(true)
    expect(note).toContain('2022 GMC Sierra')
    expect(extractPsid(note)).toBe(id)
  })

  it('psidTag / extractPsid round-trip; non-tagged notes → null', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(extractPsid(psidTag(id))).toBe(id)
    expect(extractPsid('just a note')).toBeNull()
    expect(extractPsid(null)).toBeNull()
  })
})
