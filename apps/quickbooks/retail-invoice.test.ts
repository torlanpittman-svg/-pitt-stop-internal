import { describe, it, expect } from 'vitest'
import { buildRetailPayload, RetailTotalMismatchError } from './retail-invoice'

const SIERRA = { year: '2022', make: 'GMC', model: 'Sierra', vin: '1GTV2TEC1234567' }
const EST = '11111111-2222-3333-4444-555555555555'

describe('buildRetailPayload (pure, P-D3.1)', () => {
  it('flat $650 Job → one Labor line (vehicle header + services) + Fees lines, total exact', () => {
    const p = buildRetailPayload({
      estimateId: EST, vehicle: SIERRA,
      workLines: [{ description: 'Interior Detail\nExterior Wash\nWax', amountCents: 65000 }],
      shopSuppliesCents: 1950, paymentChargeCents: 2009, paymentLabel: 'Card Payment',
      expectedTotalCents: 68959,
    })
    expect(p.lines).toHaveLength(3)
    expect(p.lines[0].itemKind).toBe('labor')
    expect(p.lines[0].description).toBe('2022 GMC Sierra\nVIN: 1GTV2TEC1234567\n\nInterior Detail\nExterior Wash\nWax')
    expect(p.lines[0].amountCents).toBe(65000)
    expect(p.lines[1]).toEqual({ itemKind: 'fees', description: 'Shop supplies', amountCents: 1950 })
    expect(p.lines[2]).toEqual({ itemKind: 'fees', description: 'Card Payment', amountCents: 2009 })
    expect(p.totalCents).toBe(68959)
    expect(p.privateNote).toContain(`PSID:${EST}`)
    expect(p.privateNote).not.toContain('\n')       // single-line internal note
  })

  it('sum of Work + Shop + Payment equals the draft total', () => {
    const p = buildRetailPayload({
      estimateId: EST, vehicle: SIERRA, workLines: [{ description: 'x', amountCents: 65000 }],
      shopSuppliesCents: 1950, paymentChargeCents: 2009, paymentLabel: 'Card Payment', expectedTotalCents: 68959,
    })
    expect(p.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(68959)
  })

  it('waived payment charge → line omitted, total still exact ($669.50)', () => {
    const p = buildRetailPayload({
      estimateId: EST, vehicle: SIERRA, workLines: [{ description: 'x', amountCents: 65000 }],
      shopSuppliesCents: 1950, paymentChargeCents: 0, paymentLabel: 'Card Payment', expectedTotalCents: 66950,
    })
    expect(p.lines).toHaveLength(2)
    expect(p.lines.some((l) => l.description === 'Card Payment')).toBe(false)
    expect(p.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(66950)
  })

  it('waived shop supplies → line omitted', () => {
    const p = buildRetailPayload({
      estimateId: EST, vehicle: SIERRA, workLines: [{ description: 'x', amountCents: 65000 }],
      shopSuppliesCents: 0, paymentChargeCents: 1950, paymentLabel: 'Card Payment', expectedTotalCents: 66950,
    })
    expect(p.lines).toHaveLength(2)
    expect(p.lines.some((l) => l.description === 'Shop supplies')).toBe(false)
  })

  it('uses the configurable payment label (not hard-coded)', () => {
    const p = buildRetailPayload({
      estimateId: EST, vehicle: SIERRA, workLines: [{ description: 'x', amountCents: 65000 }],
      shopSuppliesCents: 0, paymentChargeCents: 1950, paymentLabel: 'CC Processing Fee', expectedTotalCents: 66950,
    })
    expect(p.lines.find((l) => l.itemKind === 'fees')?.description).toBe('CC Processing Fee')
  })

  it('itemized Job → one generic Labor line per service, first has the vehicle header', () => {
    const p = buildRetailPayload({
      estimateId: EST, vehicle: SIERRA,
      workLines: [
        { description: 'Interior Detail', amountCents: 30000 },
        { description: 'Exterior Wash', amountCents: 15000 },
        { description: 'Wax', amountCents: 10000 },
      ],
      shopSuppliesCents: 1650, paymentChargeCents: 1700, paymentLabel: 'Card Payment', expectedTotalCents: 58350,
    })
    expect(p.lines.filter((l) => l.itemKind === 'labor')).toHaveLength(3)
    expect(p.lines[0].description.startsWith('2022 GMC Sierra')).toBe(true)
    expect(p.lines[1].description).toBe('Exterior Wash')   // no header on subsequent lines
    expect(p.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(58350)
  })

  it('THROWS when the sum does not equal the total (e.g. tax-inclusive) — never silently continues', () => {
    expect(() => buildRetailPayload({
      estimateId: EST, vehicle: SIERRA, workLines: [{ description: 'x', amountCents: 65000 }],
      shopSuppliesCents: 1950, paymentChargeCents: 2009, paymentLabel: 'Card Payment',
      expectedTotalCents: 74322,   // total includes tax → mismatch
    })).toThrow(RetailTotalMismatchError)
  })
})
