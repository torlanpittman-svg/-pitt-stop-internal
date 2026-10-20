import { describe, it, expect } from 'vitest'
import { computeFees, effectiveFeeConfig, explicitPretaxTotals, type FeeConfig } from './fees'
import { buildRetailPayload } from '@/apps/quickbooks/retail-invoice'

// Removing / restoring Shop supplies and the Card charge (Invoice Draft + Customer estimate). The
// choice is a per-Job waiver; the ONE fee engine recomputes everything from it, and the QuickBooks
// payload is built from those same amounts. Reference: owner's example Job — $2,100 work, $20 supplies
// (3% capped), $63.60 card (3% of work + supplies), $0 tax, $2,183.60 total.
const BASE: FeeConfig = {
  shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000,
  paymentEnabled: true, paymentBps: 300, paymentLabel: 'Card Payment', paymentBasis: 'work_plus_supplies',
}
const WORK = 210000
const totalsWith = (waive: { waiveShopSupplies?: boolean; waivePayment?: boolean }) =>
  explicitPretaxTotals(WORK, effectiveFeeConfig(BASE, { isDealer: false, ...waive }), 0, 'detailing')

const qbPayload = (t: ReturnType<typeof totalsWith>) => buildRetailPayload({
  estimateId: '11111111-2222-3333-4444-555555555555', vehicle: { year: '2022', make: 'GMC', model: 'Sierra', vin: null },
  feesItemId: 'FEE', paymentLabel: 'Card Payment', shopSuppliesLabel: 'Shop supplies',
  workServices: [{ itemId: '8', description: 'Full Detail', amountCents: t.workPriceCents }],
  shopSuppliesCents: t.shopSuppliesCents, paymentChargeCents: t.paymentChargeCents, expectedTotalCents: t.totalCents,
})

describe('fee removal — reference Job ($2,100 work)', () => {
  it('nothing removed → $20 supplies + $63.60 card = $2,183.60', () => {
    const t = totalsWith({})
    expect([t.shopSuppliesCents, t.paymentChargeCents, t.taxCents, t.totalCents]).toEqual([2000, 6360, 0, 218360])
  })
  it('card charge removed → $2,120.00', () => {
    const t = totalsWith({ waivePayment: true })
    expect([t.shopSuppliesCents, t.paymentChargeCents, t.totalCents]).toEqual([2000, 0, 212000])
  })
  it('both removed → $2,100.00', () => {
    const t = totalsWith({ waiveShopSupplies: true, waivePayment: true })
    expect([t.shopSuppliesCents, t.paymentChargeCents, t.totalCents]).toEqual([0, 0, 210000])
  })
  it('shop supplies removed → the dependent card charge is recalculated on work alone ($63.00)', () => {
    const t = totalsWith({ waiveShopSupplies: true })
    expect([t.shopSuppliesCents, t.paymentChargeCents, t.totalCents]).toEqual([0, 6300, 216300])
  })
  it('restoring brings the original amounts back exactly', () => {
    expect(totalsWith({ waivePayment: false, waiveShopSupplies: false })).toEqual(totalsWith({}))
  })
  it('itemized basis gives the same fees as the flat basis', () => {
    expect(computeFees(WORK, effectiveFeeConfig(BASE, { isDealer: false, waivePayment: true })))
      .toEqual([{ feeCode: 'shop_supplies', name: 'Shop supplies (3%)', priceCents: 2000 }])
  })
  it('dealer Jobs never carry either charge, waived or not', () => {
    const cfg = effectiveFeeConfig(BASE, { isDealer: true })
    expect(computeFees(WORK, cfg)).toEqual([])
  })
})

describe('fee removal — the QuickBooks document matches the same selections', () => {
  it('card removed → no card line; QB lines sum to $2,120.00', () => {
    const p = qbPayload(totalsWith({ waivePayment: true }))
    expect(p.lines.map((l) => [l.description, l.amountCents])).toEqual([['Full Detail', 210000], ['Shop supplies', 2000]])
    expect(p.totalCents).toBe(212000)
  })
  it('both removed → work line only; $2,100.00', () => {
    const p = qbPayload(totalsWith({ waiveShopSupplies: true, waivePayment: true }))
    expect(p.lines.map((l) => [l.description, l.amountCents])).toEqual([['Full Detail', 210000]])
    expect(p.totalCents).toBe(210000)
  })
  it('nothing removed → both fee lines; $2,183.60', () => {
    const p = qbPayload(totalsWith({}))
    expect(p.lines.map((l) => l.amountCents)).toEqual([210000, 2000, 6360])
    expect(p.totalCents).toBe(218360)
  })
})
