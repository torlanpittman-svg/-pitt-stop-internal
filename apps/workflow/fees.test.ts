import { describe, it, expect } from 'vitest'
import {
  feePercentLabel, eligibleBasisCents, computeShopSupplies, computeCardFee,
  computeFees, reconcilePlan, explicitPretaxTotals, type FeeConfig, type ExistingFeeLine,
} from './fees'

const CFG = (over: Partial<FeeConfig> = {}): FeeConfig => ({
  shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000,
  cardFeeEnabled: false, cardFeeBps: 300, ...over,
})

describe('feePercentLabel', () => {
  it('formats bps', () => {
    expect(feePercentLabel(300)).toBe('3%')
    expect(feePercentLabel(325)).toBe('3.25%')
    expect(feePercentLabel(250)).toBe('2.5%')
  })
})

describe('eligibleBasisCents', () => {
  it('sums non-generated line amounts (price × qty), excludes generated fees', () => {
    const lines = [
      { priceCents: 30000, qty: 1, generated: false },              // 300.00 labor
      { priceCents: 5000,  qty: '2', generated: false },            // 100.00 parts
      { priceCents: 1500,  qty: 1, generated: true },               // a fee — excluded
    ]
    expect(eligibleBasisCents(lines)).toBe(40000)
  })
})

describe('computeShopSupplies — 3% capped at $20', () => {
  const S = (dollars: number) => computeShopSupplies(Math.round(dollars * 100), 300, 2000)
  it('required examples', () => {
    expect(S(100)).toBe(300)       // $3.00
    expect(S(300)).toBe(900)       // $9.00
    expect(S(500)).toBe(1500)      // $15.00
    expect(S(666.67)).toBe(2000)   // ~$20.00 after rounding (2000.01 → 2000, capped)
    expect(S(1000)).toBe(2000)     // capped $20.00
    expect(S(5000)).toBe(2000)     // capped $20.00
  })
  it('cap and rate are config, not hard-coded', () => {
    expect(computeShopSupplies(100000, 500, 2000)).toBe(2000)   // 5% of $1000 = $50 → capped $20
    expect(computeShopSupplies(100000, 300, 5000)).toBe(3000)   // higher cap → $30
    expect(computeShopSupplies(0, 300, 2000)).toBe(0)
  })
})

describe('computeCardFee', () => {
  it('percentage, no cap', () => {
    expect(computeCardFee(50000, 300)).toBe(1500)
    expect(computeCardFee(100000, 300)).toBe(3000)
  })
})

describe('computeFees', () => {
  it('shop only by default (card disabled)', () => {
    const fees = computeFees(50000, CFG())
    expect(fees.map((f) => f.feeCode)).toEqual(['shop_supplies'])
    expect(fees[0]).toMatchObject({ priceCents: 1500, name: 'Shop supplies (3%)' })
  })
  it('both when card enabled', () => {
    const fees = computeFees(50000, CFG({ cardFeeEnabled: true }))
    expect(fees.map((f) => f.feeCode)).toEqual(['shop_supplies', 'card_fee'])
    expect(fees.find((f) => f.feeCode === 'card_fee')).toMatchObject({ priceCents: 1500, name: 'Card processing (3%)' })
  })
  it('zero basis → no fee lines', () => {
    expect(computeFees(0, CFG({ cardFeeEnabled: true }))).toEqual([])
  })
  it('shop supplies respects the cap inside computeFees', () => {
    expect(computeFees(500000, CFG())[0].priceCents).toBe(2000)
  })
})

describe('explicitPretaxTotals (manager work price + fees/tax on top)', () => {
  it('$650 → shop supplies $19.50, tax review $0, total $669.50', () => {
    const t = explicitPretaxTotals(65000, CFG(), 825, 'review')
    expect(t.workPriceCents).toBe(65000)
    expect(t.shopSuppliesCents).toBe(1950)          // 3% of $650
    expect(t.cardFeeCents).toBe(0)                  // card disabled
    expect(t.needsTaxReview).toBe(true)             // 'review' → do not guess tax
    expect(t.taxCents).toBe(0)
    expect(t.nontaxableSubtotalCents).toBe(66950)   // work + shop supplies, both non-taxable(review)
    expect(t.taxableSubtotalCents).toBe(0)
    expect(t.totalCents).toBe(66950)                // $669.50 — no double-count of service lines
  })
  it('shop supplies capped at $20 for large work prices', () => {
    const t = explicitPretaxTotals(100000, CFG(), 825, 'review')  // $1000
    expect(t.shopSuppliesCents).toBe(2000)
    expect(t.totalCents).toBe(102000)
  })
  it('card fee applies on top when enabled', () => {
    const t = explicitPretaxTotals(65000, CFG({ cardFeeEnabled: true }), 825, 'review')
    expect(t.cardFeeCents).toBe(1950)
    expect(t.totalCents).toBe(65000 + 1950 + 1950)  // work + shop + card
  })
  it('zero work price → all zero', () => {
    const t = explicitPretaxTotals(0, CFG(), 825, 'review')
    expect(t.totalCents).toBe(0); expect(t.shopSuppliesCents).toBe(0)
  })
  it('taxable category taxes the work amount (engine supports it; P-B2 defaults to review)', () => {
    const t = explicitPretaxTotals(65000, CFG(), 825, 'repair_parts')
    expect(t.taxableSubtotalCents).toBe(65000)                 // work amount taxed
    expect(t.taxCents).toBe(Math.round(65000 * 825 / 10000))   // 5363
    // needs_tax_review stays true: the shop-supplies fee line is still 'review' (CPA-pending)
    expect(t.needsTaxReview).toBe(true)
  })
})

describe('reconcilePlan — idempotency / no duplicates', () => {
  const shop = (id: string, cents: number): ExistingFeeLine => ({ id, feeCode: 'shop_supplies', priceCents: cents, name: 'Shop supplies (3%)' })
  it('inserts when missing', () => {
    const plan = reconcilePlan([], computeFees(50000, CFG()))
    expect(plan.toInsert.map((f) => f.feeCode)).toEqual(['shop_supplies'])
    expect(plan.toUpdate).toEqual([]); expect(plan.toDelete).toEqual([])
  })
  it('updates in place when the amount changes ($15 → $18), never a 2nd line', () => {
    const plan = reconcilePlan([shop('L1', 1500)], computeFees(60000, CFG()))
    expect(plan.toInsert).toEqual([])
    expect(plan.toUpdate).toEqual([{ id: 'L1', feeCode: 'shop_supplies', name: 'Shop supplies (3%)', priceCents: 1800 }])
    expect(plan.toDelete).toEqual([])
  })
  it('no-op when nothing changed (re-running recompute)', () => {
    const plan = reconcilePlan([shop('L1', 1500)], computeFees(50000, CFG()))
    expect(plan.toInsert).toEqual([]); expect(plan.toUpdate).toEqual([]); expect(plan.toDelete).toEqual([])
  })
  it('deletes a fee that is no longer desired (disabled / zero basis)', () => {
    const card: ExistingFeeLine = { id: 'C1', feeCode: 'card_fee', priceCents: 1500, name: 'Card processing (3%)' }
    const plan = reconcilePlan([shop('L1', 1500), card], computeFees(50000, CFG()))  // card disabled
    expect(plan.toDelete).toEqual(['C1'])
    expect(plan.toInsert).toEqual([]); expect(plan.toUpdate).toEqual([])
  })
})
