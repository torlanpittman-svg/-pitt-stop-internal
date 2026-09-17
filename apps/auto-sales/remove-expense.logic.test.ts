import { describe, it, expect } from 'vitest'
import { isRemovableVehicleExpense, REMOVABLE_EXPENSE_CATEGORIES, ECONOMIC_CATEGORIES } from './types'
import { computeSummary } from './db'
import type { vehicleFinancialEvents } from './schema'

// A minimal event factory — only the fields computeSummary reads matter; the rest are filled to satisfy the type.
type Ev = typeof vehicleFinancialEvents.$inferSelect
let seq = 0
const ev = (o: Partial<Ev>): Ev => ({
  id: o.id ?? `e${seq++}`, inventoryVehicleId: 'veh-1', economicCategory: 'part', cashflowCategory: 'operating',
  accountingTreatment: 'unknown_confirm', amountCents: 0, eventDate: '2026-03-01', vendor: null, memo: null,
  paymentAccountRef: null, finTransactionId: null, reversesEventId: null, originalEventId: null, documentId: null,
  status: 'verified', source: 'manual', evidence: null, refundStatus: null, refundMethod: null, refundKind: null,
  createdBy: null, createdAt: new Date(), ...o,
}) as unknown as Ev

describe('isRemovableVehicleExpense — which expenses a manager may remove from a vehicle', () => {
  it('includes exactly the receipt-attachable cost buckets', () => {
    for (const c of ['part', 'recon_labor', 'mechanic', 'bodywork', 'pdr', 'paint', 'transport', 'title_tax', 'registration', 'auction_fee', 'buyer_fee'])
      expect(isRemovableVehicleExpense(c)).toBe(true)
    expect(REMOVABLE_EXPENSE_CATEGORIES).toHaveLength(11)
  })
  it('EXCLUDES acquisition, sale/lifecycle, returns/credits, floor-plan financing and corrections', () => {
    for (const c of ['acquisition', 'sale', 'deposit', 'commission', 'trade_allowance', 'return', 'refund', 'vendor_credit', 'floorplan_draw', 'floorplan_interest', 'floorplan_fee', 'curtailment', 'financing_settlement', 'adjustment', 'other'])
      expect(isRemovableVehicleExpense(c)).toBe(false)
  })
  it('every removable category is a real economic category (no typos)', () => {
    for (const c of REMOVABLE_EXPENSE_CATEGORIES) expect(ECONOMIC_CATEGORIES).toContain(c)
  })
})

describe('computeSummary — removing an expense nets it out of cost & profit (append-only correction)', () => {
  it('a live expense adds to known investment; its reversal removes it from cost', () => {
    const acq = ev({ id: 'acq', economicCategory: 'acquisition', amountCents: 1_000_000 })
    const part = ev({ id: 'part-1', economicCategory: 'part', amountCents: 25_000 })
    // Before removal: acquisition + the part are both in "in it so far".
    const before = computeSummary([acq, part], 'complete')
    expect(before.knownInvestmentCents).toBe(1_025_000)

    // Removal = an append-only adjustment that reverses the part. Both net to zero.
    const reversal = ev({ id: 'rev-1', economicCategory: 'adjustment', cashflowCategory: 'non_cash', amountCents: 25_000, reversesEventId: 'part-1' })
    const after = computeSummary([acq, part, reversal], 'complete')
    expect(after.knownInvestmentCents).toBe(1_000_000)   // back to acquisition only
    expect(after.acquisitionCostCents).toBe(1_000_000)   // acquisition untouched
    expect(after.verifiedAdditionalCents).toBe(0)
  })

  it('profit reflects the removal — a mistaken cost no longer eats the margin', () => {
    const acq = ev({ id: 'acq', economicCategory: 'acquisition', amountCents: 1_000_000 })
    const part = ev({ id: 'part-1', economicCategory: 'part', amountCents: 25_000 })
    const sale = ev({ id: 'sale', economicCategory: 'sale', amountCents: 1_200_000 })
    const withCost = computeSummary([acq, part, sale], 'complete')
    expect(withCost.proceedsCents - withCost.knownInvestmentCents).toBe(175_000)
    const reversal = ev({ id: 'rev-1', economicCategory: 'adjustment', cashflowCategory: 'non_cash', amountCents: 25_000, reversesEventId: 'part-1' })
    const removed = computeSummary([acq, part, sale, reversal], 'complete')
    expect(removed.proceedsCents - removed.knownInvestmentCents).toBe(200_000)
  })
})
