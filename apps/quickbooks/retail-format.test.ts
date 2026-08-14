import { describe, it, expect } from 'vitest'
import { formatInvoiceVehicle, buildCustomerMemo, buildPrivateNote, serviceDescription, psidTag, extractPsid, RETAIL_QB_ITEMS } from './retail-format'

const SIERRA = { year: '2022', make: 'GMC', model: 'Sierra', vin: '1GTV2TEC1234567' }

describe('retail-format (revised P-D3.1)', () => {
  it('keeps the generic-item convention', () => {
    expect(RETAIL_QB_ITEMS).toEqual({ labor: 'Labor', fees: 'Fees', parts: 'Parts' })
  })

  it('formats vehicle Year Make Model + VIN', () => {
    expect(formatInvoiceVehicle(SIERRA)).toBe('2022 GMC Sierra\nVIN: 1GTV2TEC1234567')
  })

  it('CustomerMemo is the clean customer-facing vehicle block (+ plate when present)', () => {
    expect(buildCustomerMemo(SIERRA)).toBe('2022 GMC Sierra\nVIN: 1GTV2TEC1234567')
    expect(buildCustomerMemo({ ...SIERRA, licensePlate: 'ABC1234' })).toBe('2022 GMC Sierra\nVIN: 1GTV2TEC1234567\nPlate: ABC1234')
    expect(buildCustomerMemo({ year: '2020', make: 'Honda', model: 'Civic' })).toBe('2020 Honda Civic')
    expect(buildCustomerMemo(SIERRA)).not.toContain('PSID')
  })

  it('PrivateNote carries ONLY the internal PSID tag (no vehicle)', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(buildPrivateNote(id)).toBe(`PSID:${id}`)
    expect(buildPrivateNote(id)).not.toContain('GMC')
    expect(extractPsid(buildPrivateNote(id))).toBe(id)
  })

  it('serviceDescription falls back to the service name (no AI); uses stored when given', () => {
    expect(serviceDescription('Interior Detail')).toBe('Interior Detail')
    expect(serviceDescription('Interior Detail', '   ')).toBe('Interior Detail')
    expect(serviceDescription('Interior Detail', 'Full interior deep clean')).toBe('Full interior deep clean')
  })

  it('psidTag / extractPsid round-trip; non-tagged → null', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(extractPsid(psidTag(id))).toBe(id)
    expect(extractPsid('just a note')).toBeNull()
  })
})
