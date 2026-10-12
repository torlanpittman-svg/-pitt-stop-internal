import { describe, it, expect } from 'vitest'
import { businessDate } from './dates'

describe('businessDate — checks are dated in US Central time, not UTC', () => {
  it('an evening check keeps today\'s date (UTC has already rolled over)', () => {
    expect(businessDate(new Date('2026-10-13T00:30:00Z'))).toBe('2026-10-12') // 7:30 pm CDT on the 12th
    expect(businessDate(new Date('2026-01-16T05:59:00Z'))).toBe('2026-01-15') // 11:59 pm CST
  })
  it('rolls over at Central midnight in both DST and standard time', () => {
    expect(businessDate(new Date('2026-10-13T05:00:00Z'))).toBe('2026-10-13') // 12:00 am CDT
    expect(businessDate(new Date('2026-01-16T06:00:00Z'))).toBe('2026-01-16') // 12:00 am CST
  })
})
