import { describe, it, expect } from 'vitest'
import {
  ymdInZone, monthToDateRange, formatFetchedAt, ACCOUNT_TIME_ZONE,
  zonedWallTimeToUtc, accountLocalDayStartUtc, accountLocalDayEndUtc, accountLocalPeriodToUtc,
} from './ad-dates'

describe('account-local dates (America/Chicago)', () => {
  it('does not roll over the month at a UTC boundary (Nov 1 00:30 UTC is Oct 31 in Chicago)', () => {
    const r = monthToDateRange(new Date('2026-11-01T00:30:00Z'))
    expect(r).toEqual({ from: '2026-10-01', to: '2026-10-31' })
  })

  it('resolves the local date correctly across a DST-adjacent boundary', () => {
    // 2026-03-08T05:30Z is still 2026-03-07 23:30 in Chicago (CST, UTC-6) — a different calendar day than UTC.
    expect(ymdInZone(new Date('2026-03-08T05:30:00Z'))).toBe('2026-03-07')
    // After spring-forward the same clock math still yields the correct local day.
    expect(ymdInZone(new Date('2026-03-09T12:00:00Z'))).toBe('2026-03-09')
  })

  it('month-to-date spans the 1st through today (account-local)', () => {
    expect(monthToDateRange(new Date('2026-10-28T12:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-28' })
  })

  it('formats a fetch time with an explicit timezone, and empties on a bad value', () => {
    // Regression: dateStyle/timeStyle + timeZoneName is an invalid Intl combination that throws a
    // RangeError (which crashed every live dashboard render). It must format with valid options.
    let s = ''
    expect(() => { s = formatFetchedAt('2026-10-28T20:04:00Z') }).not.toThrow()
    expect(s).toContain('2026')
    expect(s).toMatch(/\d:\d{2}/)               // includes a clock time
    expect(s).toMatch(/C[DS]T/)                 // explicit Central timezone abbreviation
    expect(formatFetchedAt(null)).toBe('')
    expect(formatFetchedAt('not-a-date')).toBe('')
  })

  it('exposes the account timezone constant', () => {
    expect(ACCOUNT_TIME_ZONE).toBe('America/Chicago')
  })
})

describe('account-local day → UTC boundary instants', () => {
  it('maps a local calendar day to the correct UTC midnight→end instants (CDT, UTC-5)', () => {
    // Oct is daylight time (CDT = UTC-5): local midnight is 05:00 UTC, not 00:00 UTC.
    expect(accountLocalDayStartUtc('2026-10-01').toISOString()).toBe('2026-10-01T05:00:00.000Z')
    expect(accountLocalDayEndUtc('2026-10-28').toISOString()).toBe('2026-10-29T04:59:59.999Z')
  })

  it('is NOT the naive UTC-midnight boundary (the bug being fixed)', () => {
    // The old overview used `new Date('2026-10-01T00:00:00Z')`, which is Sep 30 7 PM in Chicago —
    // five hours too early. The corrected start is strictly later and is really Oct 1 local.
    const naiveStart = Date.parse('2026-10-01T00:00:00Z')
    const start = accountLocalDayStartUtc('2026-10-01')
    expect(start.getTime()).toBeGreaterThan(naiveStart)
    expect(ymdInZone(start)).toBe('2026-10-01')           // start lands on Oct 1 LOCAL
    expect(ymdInZone(new Date(naiveStart))).toBe('2026-09-30') // naive UTC start was the prior local day
  })

  it('covers the ENTIRE final local day (inclusive end just before next local midnight)', () => {
    const end = accountLocalDayEndUtc('2026-10-28')
    expect(ymdInZone(end)).toBe('2026-10-28')                 // still Oct 28 local
    expect(ymdInZone(accountLocalDayStartUtc('2026-10-29'))).toBe('2026-10-29')
    // end is < next local midnight by exactly 1 ms
    expect(accountLocalDayStartUtc('2026-10-29').getTime() - end.getTime()).toBe(1)
  })

  it('handles spring-forward and fall-back (offset changes across the DST boundary)', () => {
    // Spring forward is Mar 8 2026: Mar 8 local midnight is still CST (UTC-6 → 06:00Z); Mar 9 is CDT (UTC-5 → 05:00Z).
    expect(accountLocalDayStartUtc('2026-03-08').toISOString()).toBe('2026-03-08T06:00:00.000Z')
    expect(accountLocalDayStartUtc('2026-03-09').toISOString()).toBe('2026-03-09T05:00:00.000Z')
    // Fall back is Nov 1 2026: the day STARTS in CDT (UTC-5) and ENDS in CST (UTC-6) → it is ~25h long.
    const start = accountLocalDayStartUtc('2026-11-01')
    const end = accountLocalDayEndUtc('2026-11-01')
    expect(start.toISOString()).toBe('2026-11-01T05:00:00.000Z')
    expect(end.toISOString()).toBe('2026-11-02T05:59:59.999Z')
    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000 - 1)
  })

  it('zonedWallTimeToUtc resolves an exact wall time DST-correctly', () => {
    expect(zonedWallTimeToUtc('2026-07-04T12:00:00.000').toISOString()).toBe('2026-07-04T17:00:00.000Z') // CDT
    expect(zonedWallTimeToUtc('2026-01-15T12:00:00.000').toISOString()).toBe('2026-01-15T18:00:00.000Z') // CST
  })

  it('endpoint alignment: the period maps back to the SAME local dates Google queries, even though the UTC end-date string differs', () => {
    const { from, to } = accountLocalPeriodToUtc('2026-10-01', '2026-10-28')
    // The instants belong to the advertised local days…
    expect(ymdInZone(from)).toBe('2026-10-01')
    expect(ymdInZone(to)).toBe('2026-10-28')
    // …but the end instant's UTC date is Oct 29 — which is exactly why the Google YYYY-MM-DD strings
    // must be passed explicitly and NOT derived from the shop instants' UTC date (that would query Oct 29).
    expect(to.toISOString().slice(0, 10)).toBe('2026-10-29')
  })
})
