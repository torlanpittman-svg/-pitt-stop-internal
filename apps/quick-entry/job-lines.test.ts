import { describe, it, expect } from 'vitest'
import { jobTotalCents, fmt, tierLabel, type JobLine } from './job-lines'

const line = (p: number, over: Partial<JobLine> = {}): JobLine => ({ key: 'k', catalogId: null, kind: 'package', name: 'x', priceCents: p, ...over })

describe('quick entry line math', () => {
  it('sums line prices', () => {
    expect(jobTotalCents([line(35000), line(30000), line(7500)])).toBe(72500)
  })
  it('empty list totals 0; bad values ignored', () => {
    expect(jobTotalCents([])).toBe(0)
    expect(jobTotalCents([line(NaN)])).toBe(0)
  })
  it('formats cents to dollars', () => {
    expect(fmt(35000)).toBe('$350.00')
    expect(fmt(0)).toBe('$0.00')
  })
  it('builds a readable size/condition label', () => {
    expect(tierLabel('large_3row_suv', '')).toBe('large 3row suv')
    expect(tierLabel('sedan', 'heavy')).toBe('sedan · heavy')
    expect(tierLabel('', '')).toBe('')
  })
})
