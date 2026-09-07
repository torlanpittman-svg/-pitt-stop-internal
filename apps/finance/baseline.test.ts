import { describe, it, expect } from 'vitest'
import { classifyInflow, isOperatingRevenue, cardDailyFromWeekly } from './expected-inflows'

describe('baseline inflow classification (operating revenue vs contamination)', () => {
  it('excludes internal transfers into *2649', () => {
    expect(classifyInflow('From Checking XX2649 to Checking XX0169')).toBe('transfer')
    expect(isOperatingRevenue('transfer')).toBe(false)
  })
  it('excludes vendor refunds / POS credits / returns (not new sales)', () => {
    expect(classifyInflow("POS CRE 1402 O'REILLY 6686")).toBe('refund')
    expect(classifyInflow('NAPA Auto Parts')).toBe('refund')
    expect(isOperatingRevenue('refund')).toBe(false)
  })
  it('keeps card settlements as operating revenue', () => {
    expect(classifyInflow('DEPOSIT MER BNKCD CCD 498479918886')).toBe('card')
    expect(isOperatingRevenue('card')).toBe(true)
  })
  it('KEEPS QuickBooks Payments settlements as revenue (real customer money)', () => {
    expect(classifyInflow('DEPOSIT INTUIT 60502963 CCD PYMT SOLN')).toBe('qb_payments')
    expect(isOperatingRevenue('qb_payments')).toBe(true)
  })
  it('treats generic dealer/cash deposits as revenue', () => {
    expect(classifyInflow('Deposit')).toBe('deposit')
    expect(isOperatingRevenue('deposit')).toBe(true)
  })
})

describe('card baseline math (fixed denominator)', () => {
  it('divides a weekly card run-rate across the 6 operating days, not settlement-days', () => {
    // ~$3,300/wk observed → ~$550/day, NOT the old ~$924/day (which divided by busy days only).
    expect(cardDailyFromWeekly(330000)).toBe(55000)
    expect(cardDailyFromWeekly(0)).toBe(0)
  })
})
