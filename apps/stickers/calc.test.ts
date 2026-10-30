import { describe, it, expect } from 'vitest'
import { addMonthsClamped, computeNextService, formatMiles, formatStickerDate, businessToday } from './calc'

describe('formatStickerDate', () => {
  it('renders the printed form', () => {
    expect(formatStickerDate('2027-02-25')).toBe('Feb 25, 2027')
    expect(formatStickerDate('2026-12-01')).toBe('Dec 1, 2026')
  })
  it('rejects garbage', () => {
    expect(formatStickerDate('2027-13-01')).toBeNull()
    expect(formatStickerDate('not a date')).toBeNull()
    expect(formatStickerDate(null)).toBeNull()
  })
})

describe('formatMiles', () => {
  it('comma-groups with the mi suffix', () => {
    expect(formatMiles(192781)).toBe('192,781 mi')
    expect(formatMiles(5000)).toBe('5,000 mi')
    expect(formatMiles(900)).toBe('900 mi')
  })
})

describe('addMonthsClamped', () => {
  it('adds plain months', () => {
    expect(addMonthsClamped('2026-10-30', 6)).toBe('2027-04-30')
  })
  it('clamps to the end of a short month', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsClamped('2027-12-31', 2)).toBe('2028-02-29') // leap year
    expect(addMonthsClamped('2026-08-31', 1)).toBe('2026-09-30')
  })
  it('crosses year boundaries', () => {
    expect(addMonthsClamped('2026-11-15', 3)).toBe('2027-02-15')
  })
})

describe('computeNextService', () => {
  it('computes both values from intervals', () => {
    expect(computeNextService({ mileage: 187781, intervalMiles: 5000, intervalMonths: 6, today: '2026-10-30' }))
      .toEqual({ nextMileage: 192781, nextDate: '2027-04-30' })
  })
  it('handles missing pieces as null (never invents an interval)', () => {
    expect(computeNextService({ mileage: 100, intervalMiles: null, intervalMonths: 6, today: '2026-10-30' }).nextMileage).toBeNull()
    expect(computeNextService({ mileage: 100, intervalMiles: 3000, intervalMonths: null, today: '2026-10-30' }).nextDate).toBeNull()
    expect(computeNextService({ mileage: null, intervalMiles: 3000, intervalMonths: null, today: '2026-10-30' }).nextMileage).toBeNull()
  })
})

describe('businessToday', () => {
  it('uses the Central calendar date, not UTC', () => {
    // 2026-10-31 02:30 UTC is still 2026-10-30 in America/Chicago (CDT, UTC-5)
    expect(businessToday(new Date('2026-10-31T02:30:00Z'))).toBe('2026-10-30')
  })
})
