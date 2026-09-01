import { describe, it, expect } from 'vitest'
import { effectiveProductionDate, retailProductionValueCents, weekStartMonday } from './production'

const TZ = 'America/Chicago'

describe('retailProductionValueCents (ONE value, precedence)', () => {
  it('explicit (manager) wins over everything', () => {
    expect(retailProductionValueCents({ explicitTotalCents: 50000, itemizedSubtotalCents: 30000, agreedPriceCents: 42500 })).toBe(50000)
  })
  it('itemized subtotal wins over agreed when no explicit', () => {
    expect(retailProductionValueCents({ explicitTotalCents: null, itemizedSubtotalCents: 30000, agreedPriceCents: 42500 })).toBe(30000)
  })
  it('agreed (employee intake) used when no manager price → $425 example', () => {
    expect(retailProductionValueCents({ explicitTotalCents: null, itemizedSubtotalCents: 0, agreedPriceCents: 42500 })).toBe(42500)
  })
  it('nothing priced → null (—), never $0', () => {
    expect(retailProductionValueCents({ explicitTotalCents: null, itemizedSubtotalCents: 0, agreedPriceCents: null })).toBeNull()
  })
  it('never sums (double-count impossible): explicit present ⇒ agreed ignored', () => {
    expect(retailProductionValueCents({ explicitTotalCents: 40000, itemizedSubtotalCents: null, agreedPriceCents: 42500 })).toBe(40000)
  })
})

describe('weekStartMonday (Mon–Sat operational week; Sunday excluded)', () => {
  it('a Wednesday resolves to that Monday', () => {
    expect(weekStartMonday('2026-08-19')).toBe('2026-08-17') // Wed Aug 19 → Mon Aug 17
  })
  it('a Monday is its own week start', () => {
    expect(weekStartMonday('2026-08-17')).toBe('2026-08-17')
  })
  it('a Saturday still maps back to that Monday', () => {
    expect(weekStartMonday('2026-08-22')).toBe('2026-08-17') // Sat Aug 22 → Mon Aug 17
  })
  it('a Sunday maps back to the PRIOR Monday (Sunday is not its own week start)', () => {
    expect(weekStartMonday('2026-08-23')).toBe('2026-08-17') // Sun Aug 23 → prior Mon Aug 17
  })
})

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
