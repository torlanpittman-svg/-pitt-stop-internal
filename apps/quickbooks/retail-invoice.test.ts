import { describe, it, expect } from 'vitest'
import { buildRetailPayload, RetailTotalMismatchError } from './retail-invoice'

const SIERRA = { year: '2022', make: 'GMC', model: 'Sierra', vin: '1GTV2TEC1234567' }
const EST = '11111111-2222-3333-4444-555555555555'
const base = {
  estimateId: EST, vehicle: SIERRA, feesItemId: 'FEE',
  paymentLabel: 'Card Payment', shopSuppliesLabel: 'Shop supplies',
}

describe('buildRetailPayload (per-service items, P-D3.1 revised)', () => {
  it('one QB line per service (own item id) + separate Fees lines; clean descriptions', () => {
    const p = buildRetailPayload({
      ...base,
      workServices: [
        { itemId: '8', description: 'Interior Detail', amountCents: 40000 },
        { itemId: '6', description: 'Exterior Wash', amountCents: 10000 },
        { itemId: 'Labor', description: 'Wax', amountCents: 15000 },
      ],
      shopSuppliesCents: 1950, paymentChargeCents: 2009, expectedTotalCents: 68959,
    })
    expect(p.lines).toHaveLength(5)
    expect(p.lines[0]).toEqual({ itemId: '8', description: 'Interior Detail', amountCents: 40000 })
    expect(p.lines[1]).toEqual({ itemId: '6', description: 'Exterior Wash', amountCents: 10000 })
    expect(p.lines[2]).toEqual({ itemId: 'Labor', description: 'Wax', amountCents: 15000 })   // fallback item, clean desc
    expect(p.lines[3]).toEqual({ itemId: 'FEE', description: 'Shop supplies', amountCents: 1950 })
    expect(p.lines[4]).toEqual({ itemId: 'FEE', description: 'Card Payment', amountCents: 2009 })
    // No vehicle text in any line description.
    expect(p.lines.every((l) => !l.description.includes('GMC') && !l.description.includes('VIN'))).toBe(true)
  })

  it('service amounts + fees sum exactly to the draft total', () => {
    const p = buildRetailPayload({
      ...base,
      workServices: [{ itemId: '8', description: 'Interior Detail', amountCents: 40000 }, { itemId: '6', description: 'Exterior Wash', amountCents: 10000 }, { itemId: 'Labor', description: 'Wax', amountCents: 15000 }],
      shopSuppliesCents: 1950, paymentChargeCents: 2009, expectedTotalCents: 68959,
    })
    expect(p.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(68959)
    // service lines (exclude the 2 fee lines) sum to the $650 work total
    expect(p.lines.slice(0, 3).reduce((s, l) => s + l.amountCents, 0)).toBe(65000)
  })

  it('vehicle goes in CustomerMemo (customer-facing); PSID only in PrivateNote', () => {
    const p = buildRetailPayload({ ...base, workServices: [{ itemId: '8', description: 'Interior Detail', amountCents: 65000 }], shopSuppliesCents: 1950, paymentChargeCents: 2009, expectedTotalCents: 68959 })
    expect(p.customerMemo).toBe('2022 GMC Sierra\nVIN: 1GTV2TEC1234567')
    expect(p.privateNote).toBe(`PSID:${EST}`)
    expect(p.customerMemo).not.toContain('PSID')
  })

  it('waived payment charge → omitted; total still exact', () => {
    const p = buildRetailPayload({ ...base, workServices: [{ itemId: '8', description: 'Interior Detail', amountCents: 65000 }], shopSuppliesCents: 1950, paymentChargeCents: 0, expectedTotalCents: 66950 })
    expect(p.lines).toHaveLength(2)
    expect(p.lines.some((l) => l.description === 'Card Payment')).toBe(false)
    expect(p.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(66950)
  })

  it('uses the configurable payment label', () => {
    const p = buildRetailPayload({ ...base, paymentLabel: 'CC Processing Fee', workServices: [{ itemId: '8', description: 'x', amountCents: 65000 }], shopSuppliesCents: 0, paymentChargeCents: 1950, expectedTotalCents: 66950 })
    expect(p.lines.find((l) => l.itemId === 'FEE')?.description).toBe('CC Processing Fee')
  })

  it('THROWS when Σ lines != total (never silently continues)', () => {
    expect(() => buildRetailPayload({ ...base, workServices: [{ itemId: '8', description: 'x', amountCents: 65000 }], shopSuppliesCents: 1950, paymentChargeCents: 2009, expectedTotalCents: 74322 }))
      .toThrow(RetailTotalMismatchError)
  })
})
