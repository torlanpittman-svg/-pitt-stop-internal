import { describe, it, expect } from 'vitest'
import { classifyIntake } from './intake-classify'

const VIN = '1HGCM82633A004352' // valid-format 17-char VIN

describe('classifyIntake', () => {
  it('barcode VIN → retail (0 AI)', () => {
    expect(classifyIntake({ barcodeVin: VIN })).toBe('retail')
  })

  it('dealer resolved + valid stock → dealer', () => {
    expect(classifyIntake({ dealer: { stockNumber: 'S72951', dealerResolved: true } })).toBe('dealer')
  })

  it('dealer wins even when a VIN is also present (dealer-with-VIN tag)', () => {
    expect(classifyIntake({
      dealer: { stockNumber: 'K1234', dealerResolved: true },
      vin: { vin: VIN, valid: true },
    })).toBe('dealer')
  })

  it('valid VIN, no dealer → retail', () => {
    expect(classifyIntake({ dealer: { stockNumber: null, dealerResolved: false }, vin: { vin: VIN, valid: true } })).toBe('retail')
  })

  it('invalid VIN never → retail (→ unknown)', () => {
    expect(classifyIntake({ vin: { vin: 'NOTAVIN', valid: false } })).toBe('unknown')
    expect(classifyIntake({ dealer: { stockNumber: null, dealerResolved: false }, vin: { vin: 'SHORT', valid: true } })).toBe('unknown')
  })

  it('dealer NOT resolved (stock prefix unknown) → not dealer', () => {
    expect(classifyIntake({ dealer: { stockNumber: 'Z9999', dealerResolved: false } })).toBe('unknown')
  })

  it('dealer resolved but stock shape implausible → not dealer', () => {
    // resolved=true but a garbage token that is not stock-shaped must not be treated as a dealer tag
    expect(classifyIntake({ dealer: { stockNumber: '1HGCM82633A004352', dealerResolved: true } })).toBe('unknown')
  })

  it('no evidence → unknown', () => {
    expect(classifyIntake({})).toBe('unknown')
    expect(classifyIntake({ dealer: null, vin: null, barcodeVin: null })).toBe('unknown')
  })
})
