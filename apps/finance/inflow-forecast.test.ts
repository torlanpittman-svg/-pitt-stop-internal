import { describe, it, expect } from 'vitest'
import { computeInflowForecast, weekKey } from './inflow-forecast'

describe('inflow anti-double-count engine', () => {
  it('specific DATED evidence SUPPRESSES the same week\'s baseline (does not stack)', () => {
    // Owner example: baseline says ~$10,000 this week; a specific $7,000 Sterling receivable is dated
    // Friday of the SAME week. Expected total must stay ~$10,000, not $17,000.
    const week = '2026-09-11' // a Friday
    const f = computeInflowForecast({
      horizonDays: 7,
      dated: [{ date: week, cents: 700000, label: 'Sterling', level: 'L2' }],
      baseline: [{ date: week, cents: 1000000 }],
      amountKnownDateUnknownCents: 0, earnedUninvoicedCents: 0,
    })
    expect(f.specificDatedCents).toBe(700000)
    expect(f.baselineResidualCents).toBe(300000)          // 10,000 − 7,000
    expect(f.expectedTotalCents).toBe(1000000)            // NOT 1,700,000
  })

  it('undated receivable (L2b) does NOT suppress a dated baseline week', () => {
    const f = computeInflowForecast({
      horizonDays: 7,
      dated: [],
      baseline: [{ date: '2026-09-11', cents: 1000000 }],
      amountKnownDateUnknownCents: 700000,   // known amount, unknown cash date
      earnedUninvoicedCents: 0,
    })
    expect(f.baselineResidualCents).toBe(1000000)         // baseline untouched
    expect(f.expectedTotalCents).toBe(1000000)
    expect(f.amountKnownDateUnknownCents).toBe(700000)    // shown separately, not added to the dated total
  })

  it('residual baseline is floored at 0 (specific exceeding baseline never goes negative)', () => {
    const f = computeInflowForecast({
      horizonDays: 7,
      dated: [{ date: '2026-09-11', cents: 1500000, label: 'Sterling', level: 'L2' }],
      baseline: [{ date: '2026-09-11', cents: 1000000 }],
      amountKnownDateUnknownCents: 0, earnedUninvoicedCents: 0,
    })
    expect(f.baselineResidualCents).toBe(0)
    expect(f.expectedTotalCents).toBe(1500000)            // the real dated receivable stands
  })

  it('suppression is per-week: a specific dollar in week A does not reduce week B baseline', () => {
    const f = computeInflowForecast({
      horizonDays: 30,
      dated: [{ date: '2026-09-11', cents: 700000, label: 'Sterling', level: 'L2' }],
      baseline: [{ date: '2026-09-11', cents: 1000000 }, { date: '2026-09-18', cents: 1000000 }],
      amountKnownDateUnknownCents: 0, earnedUninvoicedCents: 0,
    })
    const wA = f.weeks.find((w) => w.week === weekKey('2026-09-11'))!
    const wB = f.weeks.find((w) => w.week === weekKey('2026-09-18'))!
    expect(wA.residualCents).toBe(300000)
    expect(wB.residualCents).toBe(1000000)                // untouched
    expect(f.expectedTotalCents).toBe(700000 + 300000 + 1000000)
  })

  it('L1 settling is surfaced separately and defaults to 0 without Payments scope', () => {
    const f = computeInflowForecast({ horizonDays: 7, dated: [], baseline: [], amountKnownDateUnknownCents: 0, earnedUninvoicedCents: 365000 })
    expect(f.verifiedSettlingCents).toBe(0)
    expect(f.earnedUninvoicedCents).toBe(365000)          // carried, not added to expected total
    expect(f.expectedTotalCents).toBe(0)
  })
})
