import { describe, it, expect } from 'vitest'
import {
  feePercentLabel, eligibleBasisCents, computeShopSupplies, computePaymentCharge,
  computeFees, reconcilePlan, explicitPretaxTotals, effectiveFeeConfig, isDealerOrder, orderSourceKind,
  type FeeConfig, type ExistingFeeLine,
} from './fees'

describe('orderSourceKind', () => {
  it('dealer sources → dealer', () => {
    expect(orderSourceKind({ source: 'dealer' })).toBe('dealer')
    expect(orderSourceKind({ source: 'dealer_checkin' })).toBe('dealer')
    expect(orderSourceKind({ serviceType: 'dealer_detail' })).toBe('dealer')
  })
  it('retail sources → retail', () => {
    expect(orderSourceKind({ source: 'quick_entry' })).toBe('retail')
    expect(orderSourceKind({ source: 'walk_in' })).toBe('retail')
    expect(orderSourceKind({ source: 'vin_scan' })).toBe('retail')
    expect(orderSourceKind({ serviceType: 'retail' })).toBe('retail')
  })
  it('null / legacy / unrecognized source → unknown (never falsely labeled)', () => {
    expect(orderSourceKind({ source: null })).toBe('unknown')
    expect(orderSourceKind({})).toBe('unknown')
    expect(orderSourceKind({ source: 'import_legacy' })).toBe('unknown')
  })
  it('dealer wins even if a retail-ish serviceType is present', () => {
    expect(orderSourceKind({ source: 'dealer', serviceType: 'retail' })).toBe('dealer')
  })
})

// Production retail defaults: shop supplies ON (3%, cap $20), payment charge ON (3%,
// basis = work + supplies).
const CFG = (over: Partial<FeeConfig> = {}): FeeConfig => ({
  shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000,
  paymentEnabled: true, paymentBps: 300, paymentLabel: 'Card Payment', paymentBasis: 'work_plus_supplies',
  ...over,
})

describe('feePercentLabel', () => {
  it('formats bps', () => { expect(feePercentLabel(300)).toBe('3%'); expect(feePercentLabel(325)).toBe('3.25%') })
})

describe('eligibleBasisCents', () => {
  it('sums non-generated line amounts, excludes generated fees', () => {
    expect(eligibleBasisCents([
      { priceCents: 30000, qty: 1, generated: false }, { priceCents: 5000, qty: '2', generated: false },
      { priceCents: 1500, qty: 1, generated: true },
    ])).toBe(40000)
  })
})

describe('computeShopSupplies — 3% capped $20', () => {
  const S = (d: number) => computeShopSupplies(Math.round(d * 100), 300, 2000)
  it('examples', () => {
    expect(S(100)).toBe(300); expect(S(300)).toBe(900); expect(S(500)).toBe(1500)
    expect(S(666.67)).toBe(2000); expect(S(1000)).toBe(2000); expect(S(5000)).toBe(2000)
  })
})

describe('computePaymentCharge', () => {
  it('3% of the passed basis (no cap)', () => {
    expect(computePaymentCharge(66950, 300)).toBe(2009)   // 3% of $669.50 = $20.09
    expect(computePaymentCharge(65000, 300)).toBe(1950)
  })
})

describe('computeFees (retail default: shop + payment)', () => {
  it('$650 → shop $19.50 + Card Payment $20.09 (basis = work + supplies)', () => {
    const f = computeFees(65000, CFG())
    expect(f.map((x) => x.feeCode)).toEqual(['shop_supplies', 'payment_charge'])
    expect(f.find((x) => x.feeCode === 'shop_supplies')!.priceCents).toBe(1950)
    expect(f.find((x) => x.feeCode === 'payment_charge')!.priceCents).toBe(2009)
    expect(f.find((x) => x.feeCode === 'payment_charge')!.name).toBe('Card Payment (3%)')
  })
  it('payment disabled → shop only', () => {
    expect(computeFees(65000, CFG({ paymentEnabled: false })).map((x) => x.feeCode)).toEqual(['shop_supplies'])
  })
  it('payment basis work_only', () => {
    expect(computeFees(65000, CFG({ paymentBasis: 'work_only' })).find((x) => x.feeCode === 'payment_charge')!.priceCents).toBe(1950)
  })
})

describe('isDealerOrder', () => {
  it('detects dealer by source/type', () => {
    expect(isDealerOrder({ source: 'dealer', serviceType: 'dealer_detail' })).toBe(true)
    expect(isDealerOrder({ source: 'dealer_checkin' })).toBe(true)
    expect(isDealerOrder({ source: 'quick_entry', serviceType: 'retail' })).toBe(false)
  })
})

describe('effectiveFeeConfig', () => {
  it('dealer → shop supplies + payment forced OFF', () => {
    const c = effectiveFeeConfig(CFG(), { isDealer: true })
    expect(c.shopSuppliesEnabled).toBe(false); expect(c.paymentEnabled).toBe(false)
  })
  it('retail waivers remove the charge', () => {
    expect(effectiveFeeConfig(CFG(), { isDealer: false, waiveShopSupplies: true }).shopSuppliesEnabled).toBe(false)
    expect(effectiveFeeConfig(CFG(), { isDealer: false, waivePayment: true }).paymentEnabled).toBe(false)
    const both = effectiveFeeConfig(CFG(), { isDealer: false })
    expect(both.shopSuppliesEnabled).toBe(true); expect(both.paymentEnabled).toBe(true)
  })
})

describe('REGRESSION — retail vs dealer totals', () => {
  it('1) Retail $650 detail: shop $19.50, payment $20.09, tax $0, total $689.59', () => {
    const t = explicitPretaxTotals(65000, effectiveFeeConfig(CFG(), { isDealer: false }), 825, 'detailing')
    expect(t.shopSuppliesCents).toBe(1950)
    expect(t.paymentChargeCents).toBe(2009)
    expect(t.taxCents).toBe(0)                 // detailing is non-taxable
    expect(t.needsTaxReview).toBe(false)       // no review clutter for detailing
    expect(t.totalCents).toBe(68959)           // $689.59
  })
  it('2) Dealer $200 Complete Detail: no shop, no payment, no tax, total $200', () => {
    const t = explicitPretaxTotals(20000, effectiveFeeConfig(CFG(), { isDealer: true }), 0, 'detailing')
    expect(t.shopSuppliesCents).toBe(0)
    expect(t.paymentChargeCents).toBe(0)
    expect(t.taxCents).toBe(0)
    expect(t.totalCents).toBe(20000)
  })
  it('3) Dealer $125 → total $125', () => {
    expect(explicitPretaxTotals(12500, effectiveFeeConfig(CFG(), { isDealer: true }), 0, 'detailing').totalCents).toBe(12500)
  })
  it('4) Dealer $75 → total $75', () => {
    expect(explicitPretaxTotals(7500, effectiveFeeConfig(CFG(), { isDealer: true }), 0, 'detailing').totalCents).toBe(7500)
  })
})

describe('explicitPretaxTotals — tax', () => {
  it('taxable category taxes the work amount (mechanical/parts later)', () => {
    const t = explicitPretaxTotals(65000, CFG(), 825, 'repair_parts')
    expect(t.taxableSubtotalCents).toBe(65000)
    expect(t.taxCents).toBe(Math.round(65000 * 825 / 10000))
  })
  it('shop supplies still capped inside explicit totals', () => {
    expect(explicitPretaxTotals(500000, effectiveFeeConfig(CFG(), { isDealer: false }), 825, 'detailing').shopSuppliesCents).toBe(2000)
  })
})

describe('reconcilePlan — idempotency / no duplicates', () => {
  const shop = (id: string, cents: number): ExistingFeeLine => ({ id, feeCode: 'shop_supplies', priceCents: cents, name: 'Shop supplies (3%)' })
  it('updates in place, never a 2nd line', () => {
    const plan = reconcilePlan([shop('L1', 1500)], computeFees(60000, CFG({ paymentEnabled: false })))
    expect(plan.toInsert).toEqual([]); expect(plan.toUpdate[0].priceCents).toBe(1800); expect(plan.toDelete).toEqual([])
  })
  it('deletes a fee no longer desired (waived/dealer)', () => {
    const pay: ExistingFeeLine = { id: 'P1', feeCode: 'payment_charge', priceCents: 2009, name: 'Card Payment (3%)' }
    const plan = reconcilePlan([shop('L1', 1950), pay], computeFees(65000, effectiveFeeConfig(CFG(), { isDealer: true })))
    expect(plan.toDelete.sort()).toEqual(['L1', 'P1'])   // dealer → all fees removed
  })
})
