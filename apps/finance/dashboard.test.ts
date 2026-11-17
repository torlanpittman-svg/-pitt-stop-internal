import { describe, it, expect } from 'vitest'
import { profitLine, costDrivers, perCar, buildAttention, prevMonth, type CostTxn, type ProfitLine } from './dashboard'
import { summarizeProduction } from '@/apps/workflow/production'

const prov = (provisionalCents: number, extra: Partial<{ likelyInQuickBooksCents: number; unclearCents: number; unclear: unknown[] }> = {}) =>
  ({ provisionalCents, provisionalCount: 3, likelyInQuickBooksCents: 0, unclearCents: 0, unclear: [], ...extra }) as never

describe('profitLine — QuickBooks profit, then what QuickBooks is missing', () => {
  it('estimated profit = QuickBooks net − spending not yet in QuickBooks; costs are everything between income and net', () => {
    const p = profitLine('2026-11', { income: 19600.85, expenses: 14017.16, cogs: 275, net: 5308.69, periodEnd: '2026-11-17' }, prov(1081440))
    expect(p.incomeCents).toBe(1960085)
    expect(p.costsCents).toBe(1960085 - 530869)       // COGS + expenses, so income − costs = net exactly
    expect(p.qbNetCents).toBe(530869)
    expect(p.estimatedNetCents).toBe(530869 - 1081440)
  })
  it('a missing QuickBooks report is "can’t say" — never a $0 profit, and never an estimate built on nothing', () => {
    const p = profitLine('2026-11', null, prov(5000))
    expect(p.qbNetCents).toBeNull()
    expect(p.estimatedNetCents).toBeNull()
    expect(p.notInQuickBooksCents).toBe(5000)
  })
  it('if the provisional figure could not be computed the estimate is withheld, not assumed zero', () => {
    const p = profitLine('2026-11', { income: 100, expenses: 40, net: 60 }, null)
    expect(p.qbNetCents).toBe(6000)
    expect(p.notInQuickBooksCents).toBeNull()
    expect(p.estimatedNetCents).toBeNull()
  })
  it('prevMonth crosses a year boundary', () => {
    expect(prevMonth('2026-11')).toBe('2026-10')
    expect(prevMonth('2027-01')).toBe('2026-12')
  })
})

describe('costDrivers — costs vs cash that is not a cost', () => {
  const t = (txnClass: string, amountCents: number, merchantName: string | null = null): CostTxn => ({ txnClass, amountCents, isExpense: true, merchantName, name: merchantName })
  const d = costDrivers([
    t('payroll', 157245), t('payroll', 100612), t('expense', 135978, 'AutoLeap'), t('inventory', 3709, "O'Reilly"), t('check', 20000), t('fee', 986),
    t('debt_payment', 145576), t('owner_draw', 100000), t('transfer', 500000), t('card_payment', 55200),
  ])
  it('payroll and purchases are costs; loan payments, owner draws, transfers and card payments are not', () => {
    expect(d.costCents).toBe(157245 + 100612 + 135978 + 3709 + 20000 + 986)
    expect(d.notCostCents).toBe(145576 + 100000 + 500000 + 55200)
    expect(d.groups.find((g) => g.key === 'card')?.isCost).toBe(false)
  })
  it('every dollar lands in exactly one group', () => {
    expect(d.groups.reduce((s, g) => s + g.cents, 0)).toBe(d.costCents + d.notCostCents)
  })
  it('the transfer group says rent is inside it (rent is paid by transfer, and IS a cost)', () => {
    expect(d.groups.find((g) => g.key === 'transfers')?.note).toMatch(/rent/i)
  })
  it('names the biggest purchase vendors', () => {
    expect(d.topVendors[0]).toEqual({ label: 'AutoLeap', cents: 135978, count: 1 })
  })
})

describe('perCar — value and cost over the same cars and the same dates', () => {
  const jobs = [
    ...Array.from({ length: 3 }, () => ({ source: 'dealer' as const, priceCents: 20000 })),
    { source: 'retail' as const, priceCents: 80000 }, { source: 'retail' as const, priceCents: null },
  ]
  const s = summarizeProduction(jobs, '2026-11-01', '2026-11-16')
  const p = perCar(s, 100000)
  it('an unpriced car is not a $0 car — it is left out of the average value', () => {
    expect(s.unpricedCount).toBe(1)
    expect(p.avgValueCents).toBe(Math.round(140000 / 4))
    expect(p.retail.avgCents).toBe(80000)
    expect(p.dealer.avgCents).toBe(20000)
  })
  it('cost per car divides by ALL cars finished in the period (the work was done either way)', () => {
    expect(p.directCostPerCarCents).toBe(20000)
    expect(p.from).toBe('2026-11-01'); expect(p.to).toBe('2026-11-16')
  })
  it('no cars → no per-car figure (not a divide-by-zero or $0)', () => {
    expect(perCar(summarizeProduction([], '2026-11-01', '2026-11-16'), 5000).directCostPerCarCents).toBeNull()
  })
})

describe('buildAttention', () => {
  const line = (o: Partial<ProfitLine> = {}): ProfitLine => ({ month: '2026-11', periodEnd: null, incomeCents: 0, costsCents: 0, qbNetCents: 0, notInQuickBooksCents: 0, notInQuickBooksCount: 0, estimatedNetCents: 0, likelyInQuickBooksCents: 0, unclearReceiptCents: 0, unclearReceiptCount: 0, ...o })
  const base = { health: { status: 'fresh' as const, sources: [] }, verdict: { showNumber: true, blockers: [], cautions: [] }, projectedLowCents: 500000, projectedLowDate: '2026-12-01', quiet: [], outstanding: { checks: [], totalCents: 0, oldCents: 0 }, thisMonth: line(), lastMonth: line(), quickBooksCardThrough: '2026-11-14', today: '2026-11-17', receiptsNeedingReview: 0 }
  it('is empty when nothing is wrong', () => {
    expect(buildAttention(base)).toEqual([])
  })
  it('puts a bank that stopped updating and stale books ahead of housekeeping', () => {
    const a = buildAttention({ ...base, receiptsNeedingReview: 7, quickBooksCardThrough: '2026-10-05', thisMonth: line({ notInQuickBooksCents: 1081440 }), lastMonth: line({ notInQuickBooksCents: 1469227 }),
      health: { status: 'stale', sources: [{ label: 'Pitt Stop Auto Sales *5600', institution: 'Extraco Banks', operating: false, state: 'error', asOf: null, ageHours: 1248, detail: 'not updating' }] } })
    expect(a.map((x) => x.level)).toEqual(['now', 'now', 'tidy'])
    expect(a[1].detail).toMatch(/\$25,507/)
    expect(a.every((x) => x.href && x.action)).toBe(true)
  })
  it('warns when the projection goes below zero', () => {
    expect(buildAttention({ ...base, projectedLowCents: -437367, projectedLowDate: '2026-12-17' })[0].title).toMatch(/below zero on Dec 17/)
  })
})
