import { describe, it, expect } from 'vitest'
import { buildMonthlyReport, monthEnd, hashTotals, type ReportInvRow, type ReportEvent } from './report'

const MONTH = '2026-08'

function inv(over: Partial<ReportInvRow> & { id: string }): ReportInvRow {
  return {
    stockNumber: over.id.toUpperCase(), vin: `VIN${over.id}`, year: '2020', make: 'Test', model: 'Car',
    status: 'acquired', acquiredAt: null, soldAt: null, saleFinalized: false,
    salePriceCents: null, saleTaxCents: null, saleDocFeesCents: null, saleOtherChargesCents: null,
    saleDiscountCents: null, amountReceivedCents: null, salePaymentMethod: null, buyerRef: null, salesperson: null,
    financialCompleteness: 'complete', ...over,
  }
}
const ev = (economicCategory: string, amountCents: number, eventDate: string, over: Partial<ReportEvent> = {}): ReportEvent => ({
  id: Math.random().toString(36).slice(2), economicCategory, amountCents, eventDate, status: 'verified', ...over,
})

// V1 acquired in-month, held at month end. V2 acquired prior month, sold in-month. V3 acquired in-month
// with NO acquisition price. V4 sold before the month (out of scope). V5 acquired prior, sale reversed in-month.
const rows: ReportInvRow[] = [
  inv({ id: 'v1', acquiredAt: '2026-08-05' }),
  inv({ id: 'v2', acquiredAt: '2026-07-15', soldAt: '2026-08-20', saleFinalized: true, status: 'sold', salePriceCents: 900000, saleTaxCents: 74250, saleDocFeesCents: 15000, amountReceivedCents: 989250, buyerRef: 'Jane Buyer', salePaymentMethod: 'cash', salesperson: 'Torlan' }),
  inv({ id: 'v3', acquiredAt: '2026-08-25' }),
  inv({ id: 'v4', acquiredAt: '2026-06-01', soldAt: '2026-07-10', saleFinalized: true, status: 'sold', salePriceCents: 300000 }),
  inv({ id: 'v5', acquiredAt: '2026-07-01', status: 'listed' }),
]
const eventsByVehicle = new Map<string, ReportEvent[]>([
  ['v1', [ev('acquisition', 500000, '2026-08-05'), ev('mechanic', 40000, '2026-08-10')]],
  ['v2', [ev('acquisition', 700000, '2026-07-15'), ev('sale', 900000, '2026-08-20')]],
  ['v3', []],
  ['v4', [ev('acquisition', 250000, '2026-06-01'), ev('sale', 300000, '2026-07-10')]],
  ['v5', [ev('acquisition', 600000, '2026-07-01'), ev('sale', 850000, '2026-07-20', { id: 'sv5' }), ev('adjustment', 850000, '2026-08-15', { reversesEventId: 'sv5', evidence: { saleReversal: true } })]],
])

const report = buildMonthlyReport(rows, eventsByVehicle, MONTH, 'America/Chicago', '2026-09-01T00:00:00.000Z')

describe('monthEnd — correct last day, timezone-safe string math', () => {
  it('handles 31/30/28-day months (no UTC drift)', () => {
    expect(monthEnd('2026-08')).toBe('2026-08-31')
    expect(monthEnd('2026-04')).toBe('2026-04-30')
    expect(monthEnd('2026-02')).toBe('2026-02-28')
  })
})

describe('buildMonthlyReport — section membership respects business-date month boundaries', () => {
  it('B: acquired-in-month = only vehicles acquired within the month', () => {
    expect(report.acquired.map((r) => r.id).sort()).toEqual(['v1', 'v3'])
    expect(report.summary.acquiredCount).toBe(2)
  })
  it('C: sold-in-month excludes sales from other months', () => {
    expect(report.sold.map((r) => r.id)).toEqual(['v2'])           // v4 sold in July is excluded
    expect(report.summary.soldCount).toBe(1)
  })
  it('D: month-end inventory excludes vehicles sold by month end, includes reversed', () => {
    expect(report.endingInventory.map((r) => r.id).sort()).toEqual(['v1', 'v3', 'v5'])
    expect(report.sold.map((r) => r.id)).not.toContain('v1')       // sold ≠ in inventory
  })
  it('A: beginning inventory = held at the start of the month', () => {
    expect(report.summary.beginningInventoryCount).toBe(2)         // v2 + v5 (v4 already sold in July)
    expect(report.summary.beginningInventoryValueCents).toBe(700000 + 600000)
  })
})

describe('buildMonthlyReport — canonical money math', () => {
  it('sale figures: price, tax, fees separate; est gross profit excludes tax', () => {
    const v2 = report.sold[0]
    expect(v2.salePriceCents).toBe(900000)
    expect(v2.taxCents).toBe(74250)
    expect(v2.feesCents).toBe(15000)
    expect(v2.totalInvestedCents).toBe(700000)
    expect(v2.estGrossProfitCents).toBe(200000)                    // (900000) − 700000, tax excluded
    expect(report.summary.taxCollectedCents).toBe(74250)
    expect(report.summary.estGrossProfitOnSoldCents).toBe(200000)
  })
  it('ending inventory value = sum of per-vehicle invested cost', () => {
    expect(report.endingInventory.find((r) => r.id === 'v1')!.totalInvestedCents).toBe(540000)
    expect(report.summary.endingInventoryValueCents).toBe(540000 + 0 + 600000)
  })
})

describe('buildMonthlyReport — totals reconcile to the vehicle-level detail rows', () => {
  it('summary equals the sum of its section rows', () => {
    const acqTotal = report.acquired.reduce((t, r) => t + r.acquisitionPriceCents, 0)
    expect(acqTotal).toBe(report.summary.acquiredPriceTotalCents)
    const saleTotal = report.sold.reduce((t, r) => t + r.salePriceCents, 0)
    expect(saleTotal).toBe(report.summary.salesPriceTotalCents)
    const gpTotal = report.sold.reduce((t, r) => t + r.estGrossProfitCents, 0)
    expect(gpTotal).toBe(report.summary.estGrossProfitOnSoldCents)
    const endTotal = report.endingInventory.reduce((t, r) => t + r.totalInvestedCents, 0)
    expect(endTotal).toBe(report.summary.endingInventoryValueCents)
  })
})

describe('buildMonthlyReport — missing/questionable data is flagged, not zeroed', () => {
  it('flags a vehicle with no acquisition price rather than treating it as sold-for-free', () => {
    const v3 = report.endingInventory.find((r) => r.id === 'v3')!
    expect(v3.acquisitionPriceCents).toBe(0)
    expect(v3.flags).toContain('missing acquisition price')
    expect(report.summary.missingAcquisitionPriceCount).toBe(1)
    expect(report.flags.some((f) => f.includes('acquisition price'))).toBe(true)
  })
  it('counts reversed/corrected sales in the month', () => {
    expect(report.summary.reversedSalesCount).toBe(1)              // v5 reversal dated in August
    expect(report.flags.some((f) => f.toLowerCase().includes('reversed'))).toBe(true)
  })
})

describe('buildMonthlyReport — reproducibility + drift detection', () => {
  it('same source data ⇒ same content hash (generatedAt does not affect it)', () => {
    const a = buildMonthlyReport(rows, eventsByVehicle, MONTH, 'America/Chicago', '2026-09-01T00:00:00Z')
    const b = buildMonthlyReport(rows, eventsByVehicle, MONTH, 'America/Chicago', '2030-01-01T12:00:00Z')
    expect(a.contentHash).toBe(b.contentHash)
  })
  it('a data change produces a different hash (post-finalization drift is detectable)', () => {
    const changed = rows.map((r) => r.id === 'v2' ? { ...r, salePriceCents: 950000 } : r)
    const after = buildMonthlyReport(changed, eventsByVehicle, MONTH, 'America/Chicago', '2026-09-01T00:00:00Z')
    expect(after.contentHash).not.toBe(report.contentHash)
  })
  it('hashTotals is order-independent over the totals object', () => {
    expect(hashTotals(report.summary)).toBe(report.contentHash)
  })
})
