import { describe, it, expect } from 'vitest'
import {
  computeCostBasis, computeSaleFinancials, computeEstimatedGrossProfit, dollarsToCents,
  isPaymentMethod, costBasisBucket, type CalcEvent,
} from './calc'

const e = (over: Partial<CalcEvent> & { economicCategory: string; amountCents: number }): CalcEvent => ({
  status: 'verified', id: Math.random().toString(36).slice(2), ...over,
})

describe('costBasisBucket — separates purchase price from other costs', () => {
  it('does not confuse acquisition with recon, taxes, fees, transport', () => {
    expect(costBasisBucket('acquisition')).toBe('acquisition')
    expect(costBasisBucket('auction_fee')).toBe('acquisition_related')
    expect(costBasisBucket('transport')).toBe('acquisition_related')
    expect(costBasisBucket('title_tax')).toBe('acquisition_related')
    expect(costBasisBucket('mechanic')).toBe('reconditioning')
    expect(costBasisBucket('part')).toBe('reconditioning')
    expect(costBasisBucket('sale')).toBe('none')
    expect(costBasisBucket('commission')).toBe('none')
  })
})

describe('computeCostBasis — canonical invested cost', () => {
  it('sums the components separately and totals them', () => {
    const b = computeCostBasis([
      e({ economicCategory: 'acquisition', amountCents: 500000 }),
      e({ economicCategory: 'auction_fee', amountCents: 25000 }),
      e({ economicCategory: 'transport', amountCents: 15000 }),
      e({ economicCategory: 'mechanic', amountCents: 40000 }),
      e({ economicCategory: 'part', amountCents: 10000 }),
    ])
    expect(b.acquisitionPriceCents).toBe(500000)
    expect(b.acquisitionRelatedCents).toBe(40000)
    expect(b.reconditioningCents).toBe(50000)
    expect(b.totalInvestedCents).toBe(590000) // 500000 + 40000 + 50000
  })

  it('returns/credits reduce the basis', () => {
    const b = computeCostBasis([
      e({ economicCategory: 'acquisition', amountCents: 500000 }),
      e({ economicCategory: 'part', amountCents: 20000 }),
      e({ economicCategory: 'refund', amountCents: 5000 }),
    ])
    expect(b.returnsCreditsCents).toBe(5000)
    expect(b.totalInvestedCents).toBe(515000)
  })

  it('unverified cost-adds are surfaced separately, never silently counted', () => {
    const b = computeCostBasis([
      e({ economicCategory: 'acquisition', amountCents: 500000 }),
      e({ economicCategory: 'part', amountCents: 20000, status: 'unverified' }),
    ])
    expect(b.reconditioningCents).toBe(0)
    expect(b.unverifiedCents).toBe(20000)
    expect(b.hasUnverified).toBe(true)
    expect(b.totalInvestedCents).toBe(500000)
  })

  it('an acquisition-price EDIT (reversal + new acquisition) yields the corrected price only', () => {
    // Mirrors editAcquisitionPrice(): reverse the old acquisition, append the new one.
    const b = computeCostBasis([
      e({ id: 'a1', economicCategory: 'acquisition', amountCents: 500000 }),
      e({ economicCategory: 'adjustment', amountCents: 500000, reversesEventId: 'a1' }),
      e({ economicCategory: 'acquisition', amountCents: 620000 }),
    ])
    expect(b.acquisitionPriceCents).toBe(620000)
    expect(b.totalInvestedCents).toBe(620000)
  })

  it('void events are excluded', () => {
    const b = computeCostBasis([
      e({ economicCategory: 'acquisition', amountCents: 500000 }),
      e({ economicCategory: 'part', amountCents: 9999, status: 'void' }),
    ])
    expect(b.totalInvestedCents).toBe(500000)
  })
})

describe('computeSaleFinancials — every component separately stated', () => {
  it('total = price − discount + tax + fees + other; balance = total − received', () => {
    const f = computeSaleFinancials({ salePriceCents: 1000000, discountCents: 50000, taxCents: 82500, docFeesCents: 15000, otherChargesCents: 5000, amountReceivedCents: 900000 })
    expect(f.totalTransactionCents).toBe(1000000 - 50000 + 82500 + 15000 + 5000) // 1,052,500
    expect(f.balanceRemainingCents).toBe(1052500 - 900000)
    expect(f.overpaidCents).toBe(0)
  })

  it('overpayment surfaces as overpaidCents, balance never negative', () => {
    const f = computeSaleFinancials({ salePriceCents: 100000, amountReceivedCents: 120000 })
    expect(f.balanceRemainingCents).toBe(0)
    expect(f.overpaidCents).toBe(20000)
  })

  it('negatives are floored to zero (defensive)', () => {
    const f = computeSaleFinancials({ salePriceCents: -5, taxCents: -5 })
    expect(f.salePriceCents).toBe(0)
    expect(f.taxCents).toBe(0)
  })
})

describe('computeEstimatedGrossProfit — taxes & fees excluded', () => {
  it('gross = (price − discount) − total invested; tax/fees do not change it', () => {
    const basis = computeCostBasis([e({ economicCategory: 'acquisition', amountCents: 600000 }), e({ economicCategory: 'mechanic', amountCents: 40000 })])
    const withTax = computeSaleFinancials({ salePriceCents: 800000, discountCents: 0, taxCents: 66000, docFeesCents: 12000 })
    const noTax = computeSaleFinancials({ salePriceCents: 800000, discountCents: 0 })
    const gpWithTax = computeEstimatedGrossProfit(withTax.salePriceCents - withTax.discountCents, basis)
    const gpNoTax = computeEstimatedGrossProfit(noTax.salePriceCents - noTax.discountCents, basis)
    expect(gpWithTax).toBe(800000 - 640000) // 160,000
    expect(gpWithTax).toBe(gpNoTax)          // taxes/fees excluded from gross profit
  })

  it('discount reduces gross profit', () => {
    const basis = computeCostBasis([e({ economicCategory: 'acquisition', amountCents: 600000 })])
    const gp = computeEstimatedGrossProfit(800000 - 50000, basis)
    expect(gp).toBe(150000)
  })

  it('an acquisition-price edit immediately changes total invested AND estimated gross profit', () => {
    const recon = e({ economicCategory: 'mechanic', amountCents: 40000 })
    const before = computeCostBasis([e({ id: 'a1', economicCategory: 'acquisition', amountCents: 500000 }), recon])
    // Same ledger after editAcquisitionPrice(620000): reverse old acquisition, append the corrected one.
    const after = computeCostBasis([
      e({ id: 'a1', economicCategory: 'acquisition', amountCents: 500000 }),
      e({ economicCategory: 'adjustment', amountCents: 500000, reversesEventId: 'a1' }),
      e({ economicCategory: 'acquisition', amountCents: 620000 }),
      recon,
    ])
    expect(before.totalInvestedCents).toBe(540000)
    expect(after.totalInvestedCents).toBe(660000)                       // +120,000 flows through immediately
    const saleNet = 800000
    expect(computeEstimatedGrossProfit(saleNet, before)).toBe(260000)
    expect(computeEstimatedGrossProfit(saleNet, after)).toBe(140000)    // gross profit drops by the same 120,000
  })
})

describe('dollarsToCents — integer-cents money, no floating point', () => {
  it('parses dollars to exact cents', () => {
    expect(dollarsToCents('19.99')).toBe(1999)
    expect(dollarsToCents('0.10')).toBe(10)
    expect(dollarsToCents('$1,250.00')).toBe(125000)
    expect(dollarsToCents(1234.56)).toBe(123456)
  })
  it('classic float trap 0.1+0.2 style stays exact', () => {
    expect(dollarsToCents('0.3')).toBe(30)
    // 10.10 + 20.20 in cents = 1010 + 2020 = 3030, never 30.299999…
    expect(dollarsToCents('10.10')! + dollarsToCents('20.20')!).toBe(3030)
  })
  it('returns null on non-finite / empty', () => {
    expect(dollarsToCents('')).toBeNull()
    expect(dollarsToCents(null)).toBeNull()
    expect(dollarsToCents('abc')).toBeNull()
  })
})

describe('isPaymentMethod', () => {
  it('accepts the known methods only', () => {
    expect(isPaymentMethod('cash')).toBe(true)
    expect(isPaymentMethod('financing')).toBe(true)
    expect(isPaymentMethod('bitcoin')).toBe(false)
    expect(isPaymentMethod(undefined)).toBe(false)
  })
})
