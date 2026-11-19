import { describe, it, expect } from 'vitest'
import { mergeReceiptExpenses, receiptToEvent, econForReceiptCategory, isReceiptEvent, type LedgerEvent, type ReceiptRow } from './receipt-expenses'
import { computeSummary } from './db'
import { computeCostBasis } from './calc'
import { costRelevance } from './types'
import { EXPENSE_CATEGORIES } from '@/apps/expenses/types'

const ev = (over: Partial<LedgerEvent>): LedgerEvent => ({
  id: 'e', inventoryVehicleId: 'v1', economicCategory: 'part', cashflowCategory: 'cash_outflow', accountingTreatment: 'unknown_confirm',
  amountCents: 1000, eventDate: '2026-11-01', vendor: null, memo: null, paymentAccountRef: 'unknown', finTransactionId: null,
  originalEventId: null, reversesEventId: null, relatedEventId: null, refundStatus: null, refundMethod: null, refundDestinationAccount: null, settledAt: null,
  status: 'verified', confidence: 'manual', source: 'manual', documentId: null, evidence: null, createdBy: 'x', createdAt: new Date('2026-11-01T12:00:00Z'), ...over,
})
const rc = (over: Partial<ReceiptRow>): ReceiptRow => ({
  id: 'r', status: 'filed', category: 'parts', vendor: 'NAPA', receiptDate: '2026-11-05', totalCents: 2500, inventoryVehicleId: 'v1',
  description: null, memo: null, accountRef: null, paymentLast4: null, filedBy: 'T', uploadedBy: 'T', createdAt: new Date('2026-11-05T12:00:00Z'), ...over,
} as ReceiptRow)

const LEDGER = [
  ev({ id: 'acq', economicCategory: 'acquisition', amountCents: 500_000 }),
  ev({ id: 'p1', economicCategory: 'part', amountCents: 12_000, eventDate: '2026-11-02' }),
  ev({ id: 'p2', economicCategory: 'transport', amountCents: 8_000, eventDate: '2026-11-02', createdAt: new Date('2026-11-02T15:00:00Z') }),
  ev({ id: 'ret', economicCategory: 'refund', amountCents: 2_000, eventDate: '2026-11-03', originalEventId: 'p1' }),
  ev({ id: 'rev', economicCategory: 'adjustment', amountCents: 8_000, eventDate: '2026-11-04', reversesEventId: 'p2' }),
  ev({ id: 'u1', economicCategory: 'other', amountCents: 700, eventDate: '2026-11-04', status: 'unverified' }),
]

describe('existing vehicle records are untouched by the receipt merge', () => {
  it('with no assigned receipts the events, their order and every total are exactly what the ledger alone gives', () => {
    const merged = mergeReceiptExpenses(LEDGER, [], new Map())
    expect(merged.events).toEqual(LEDGER)                                  // same rows, same order, nothing re-categorized
    expect(computeSummary(merged.events, 'complete')).toEqual(computeSummary(LEDGER, 'complete'))
    expect(computeCostBasis(merged.events)).toEqual(computeCostBasis(LEDGER))
  })

  it('an unassigned or rejected receipt adds nothing', () => {
    const merged = mergeReceiptExpenses(LEDGER, [rc({ id: 'a', inventoryVehicleId: null }), rc({ id: 'b', status: 'rejected' })], new Map())
    expect(merged.events).toEqual(LEDGER)
  })

  it('an assigned receipt adds ONE line and leaves every ledger row as it was (never re-bucketed)', () => {
    const merged = mergeReceiptExpenses(LEDGER, [rc({ id: 'r1', category: 'fuel' })], new Map())
    expect(merged.events.filter((e) => !isReceiptEvent(e))).toEqual(LEDGER)
    expect(merged.events.filter(isReceiptEvent)).toHaveLength(1)
    const before = computeSummary(LEDGER, 'complete'), after = computeSummary(merged.events, 'complete')
    expect(after.knownInvestmentCents - before.knownInvestmentCents).toBe(2500)
    expect(after.acquisitionCostCents).toBe(before.acquisitionCostCents)
  })

  it('a receipt matched to a live ledger line adds nothing; matched to a removed line it counts on its own', () => {
    const live = mergeReceiptExpenses(LEDGER, [rc({ id: 'r1' })], new Map([['r1', 'p1']]))
    expect(live.events).toEqual(LEDGER)
    expect(live.matchedReceipts.get('p1')?.id).toBe('r1')
    const dead = mergeReceiptExpenses(LEDGER, [rc({ id: 'r1' })], new Map([['r1', 'p2']]))   // p2 was reversed
    expect(dead.events.filter(isReceiptEvent)).toHaveLength(1)
  })
})

describe('receipt category → vehicle cost bucket (display-only mapping)', () => {
  it('every Receipts category maps to a bucket that counts as money in the vehicle', () => {
    for (const c of EXPENSE_CATEGORIES) expect(costRelevance(econForReceiptCategory(c.key))).toBe('cost_add')
    expect(econForReceiptCategory('parts')).toBe('part')
    expect(econForReceiptCategory('subcontractor')).toBe('mechanic')
    expect(econForReceiptCategory('shop_supplies')).toBe('recon_labor')
    expect(econForReceiptCategory('fuel')).toBe('other')
    expect(econForReceiptCategory(null)).toBe('other')
  })
  it('the same dollars count whatever the category — only the bucket label differs', () => {
    const total = (category: string) => computeSummary([receiptToEvent(rc({ category }))], 'complete').knownInvestmentCents
    expect(new Set(EXPENSE_CATEGORIES.map((c) => total(c.key)))).toEqual(new Set([2500]))
  })
  it('a receipt that is not filed, or has no total, is pending — never verified money', () => {
    expect(receiptToEvent(rc({ status: 'needs_review' })).status).toBe('unverified')
    expect(receiptToEvent(rc({ totalCents: null }))).toMatchObject({ status: 'unverified', amountCents: 0 })
    expect(receiptToEvent(rc({ status: 'approved' })).status).toBe('verified')
  })
})
