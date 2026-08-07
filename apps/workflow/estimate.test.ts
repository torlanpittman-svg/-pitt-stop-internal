import { describe, it, expect, afterEach } from 'vitest'
import {
  defaultTaxForType, computeTotals, rollUpDecision, approvedTitlesToSync, lineAmountCents,
  defaultTaxBps, estimateEnabled, convertSyncsServices, type CalcLine,
} from './estimate'

describe('line-level tax defaults', () => {
  it('parts taxable (repair_parts), labor non-taxable (mechanical_labor)', () => {
    expect(defaultTaxForType('part')).toEqual({ taxable: true, taxCategory: 'repair_parts' })
    expect(defaultTaxForType('labor')).toEqual({ taxable: false, taxCategory: 'mechanical_labor' })
  })
  it('fee + sublet default to review (no universal assumption)', () => {
    expect(defaultTaxForType('fee')).toEqual({ taxable: false, taxCategory: 'review' })
    expect(defaultTaxForType('sublet')).toEqual({ taxable: false, taxCategory: 'review' })
  })
})

describe('lineAmountCents', () => {
  it('rounds price × qty', () => {
    expect(lineAmountCents(15000, 2.4)).toBe(36000)   // 2.4 hrs @ $150
    expect(lineAmountCents(4999, '3')).toBe(14997)
    expect(lineAmountCents(NaN, 2)).toBe(0)
  })
})

describe('computeTotals (line-level, configured rate)', () => {
  const lines: CalcLine[] = [
    { priceCents: 15000, qty: 2.4, taxable: false, taxCategory: 'mechanical_labor' }, // labor $360 non-taxable
    { priceCents: 8000, qty: 2, taxable: true, taxCategory: 'repair_parts' },         // parts $160 taxable
  ]
  it('separates taxable vs non-taxable and taxes only taxable at the passed rate', () => {
    const t = computeTotals(lines, 825) // 8.25%
    expect(t.taxableSubtotalCents).toBe(16000)
    expect(t.nontaxableSubtotalCents).toBe(36000)
    expect(t.taxCents).toBe(1320)                 // round(16000 * 825/10000)
    expect(t.totalCents).toBe(16000 + 36000 + 1320)
    expect(t.needsTaxReview).toBe(false)
  })
  it('flags needsTaxReview when a line is category=review', () => {
    const t = computeTotals([{ priceCents: 5000, qty: 1, taxable: false, taxCategory: 'review' }], 825)
    expect(t.needsTaxReview).toBe(true)
    expect(t.taxCents).toBe(0)
  })
  it('rate is not hard-coded (0% → no tax)', () => {
    expect(computeTotals(lines, 0).taxCents).toBe(0)
  })
})

describe('rollUpDecision', () => {
  const S = (...a: ('pending' | 'approved' | 'declined' | 'deferred')[]) => a
  it('all approved → approved', () => expect(rollUpDecision(S('approved', 'approved'), 'sent')).toBe('approved'))
  it('some approved + some declined/deferred → partially_approved', () => {
    expect(rollUpDecision(S('approved', 'declined'), 'sent')).toBe('partially_approved')
    expect(rollUpDecision(S('approved', 'deferred'), 'sent')).toBe('partially_approved')
  })
  it('none approved, some declined → declined', () => expect(rollUpDecision(S('declined', 'deferred'), 'sent')).toBe('declined'))
  it('only deferred/pending → keeps current (no final decision)', () => expect(rollUpDecision(S('deferred', 'pending'), 'sent')).toBe('sent'))
})

describe('approvedTitlesToSync (Convert)', () => {
  it('syncs only APPROVED titles, additive + de-duped (case-insensitive)', () => {
    const services = [
      { title: 'Front Struts', approvalState: 'approved' as const },
      { title: 'Engine Mounts', approvalState: 'declined' as const },
      { title: 'Wax', approvalState: 'approved' as const },
      { title: 'Interior Detail', approvalState: 'deferred' as const },
    ]
    expect(approvedTitlesToSync(['interior detail'], services)).toEqual(['Front Struts', 'Wax'])
  })
})

describe('config', () => {
  const OLD = { ...process.env }
  afterEach(() => { process.env = { ...OLD } })
  it('defaultTaxBps defaults to 825 and is configurable', () => {
    delete process.env.ESTIMATE_DEFAULT_TAX_BPS; expect(defaultTaxBps()).toBe(825)
    process.env.ESTIMATE_DEFAULT_TAX_BPS = '625'; expect(defaultTaxBps()).toBe(625)
  })
  it('flags reflect env', () => {
    delete process.env.ESTIMATE_LAYER_ENABLED; expect(estimateEnabled()).toBe(false)
    process.env.ESTIMATE_LAYER_ENABLED = 'true'; expect(estimateEnabled()).toBe(true)
    process.env.ESTIMATE_CONVERT_SYNCS_SERVICES = 'true'; expect(convertSyncsServices()).toBe(true)
  })
})
