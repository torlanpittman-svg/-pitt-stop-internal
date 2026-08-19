import { describe, it, expect } from 'vitest'
import { effectiveProductionDate } from './production'

const TZ = 'America/Chicago'

describe('effectiveProductionDate', () => {
  it('override wins over completed_at', () => {
    // Completed Tue 8:04 AM Central, override Monday → effective = Monday.
    const completed = new Date('2026-08-18T13:04:00Z') // 08:04 CDT Tue Aug 18
    expect(effectiveProductionDate('2026-08-17', completed, TZ)).toBe('2026-08-17')
  })

  it('falls back to the shop-day of completed_at when no override', () => {
    const completed = new Date('2026-08-18T13:04:00Z') // Tue Aug 18 CDT
    expect(effectiveProductionDate(null, completed, TZ)).toBe('2026-08-18')
  })

  it('uses the shop timezone for the day boundary (late-night completion)', () => {
    // 2026-08-19 02:30 UTC = 2026-08-18 21:30 CDT → shop day is Aug 18, not Aug 19.
    const completed = new Date('2026-08-19T02:30:00Z')
    expect(effectiveProductionDate(null, completed, TZ)).toBe('2026-08-18')
  })

  it('override crosses a month boundary', () => {
    const completed = new Date('2026-09-01T14:00:00Z') // Sep 1 CDT
    expect(effectiveProductionDate('2026-08-31', completed, TZ)).toBe('2026-08-31')
  })

  it('null override + null completed_at → null (not completed)', () => {
    expect(effectiveProductionDate(null, null, TZ)).toBeNull()
  })
})
