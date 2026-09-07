import { describe, it, expect } from 'vitest'
import { assertCfoProductionRealm, agingOf, classifyReceivable, sterlingExpectedFriday, CFO_PRODUCTION_REALM, CFO_SANDBOX_REALM } from './qb-cfo'

describe('CFO QB production-realm fail-closed gate', () => {
  it('accepts ONLY the authoritative production realm + environment', () => {
    expect(assertCfoProductionRealm(CFO_PRODUCTION_REALM, 'production').ok).toBe(true)
  })
  it('rejects the sandbox realm (sample data can never become CFO truth)', () => {
    expect(assertCfoProductionRealm(CFO_SANDBOX_REALM, 'sandbox').ok).toBe(false)
    expect(assertCfoProductionRealm(CFO_SANDBOX_REALM, 'production').ok).toBe(false) // wrong realm even if env claims prod
    expect(assertCfoProductionRealm(CFO_PRODUCTION_REALM, 'sandbox').ok).toBe(false)  // right realm, wrong env
  })
  it('fails closed on missing/ambiguous identity', () => {
    expect(assertCfoProductionRealm(null, null).ok).toBe(false)
    expect(assertCfoProductionRealm('', 'production').ok).toBe(false)
  })
})

describe('A/R aging', () => {
  const asOf = new Date('2026-09-07T12:00:00Z')
  it('buckets by days past due', () => {
    expect(agingOf('2026-09-10', asOf).bucket).toBe('current')   // not yet due
    expect(agingOf('2026-09-01', asOf).bucket).toBe('1-30')
    expect(agingOf('2026-08-01', asOf).bucket).toBe('31-60')
    expect(agingOf('2026-07-01', asOf).bucket).toBe('61-90')
    expect(agingOf('2026-05-01', asOf).bucket).toBe('90+')
  })
  it('reports age in days and treats no-date as current', () => {
    expect(agingOf('2026-08-28', asOf).ageDays).toBe(10)
    expect(agingOf(null, asOf)).toEqual({ bucket: 'current', ageDays: 0 })
  })
})

describe('receivable classification (authoritative mapping only)', () => {
  const dealers = new Map([['6', 'Sterling Auto Group'], ['67', 'Sterling Kia'], ['836', 'Sterling Subaru']])
  const estimates = new Map([['23502', 'est-abc']])
  it('classifies dealer strictly by QB customer id', () => {
    expect(classifyReceivable({ qbInvoiceId: '9', customerId: '67' }, dealers, estimates)).toEqual({ classification: 'dealer', dealerName: 'Sterling Kia', linkedEstimateId: null })
  })
  it('classifies retail by real estimate link', () => {
    expect(classifyReceivable({ qbInvoiceId: '23502', customerId: '999' }, dealers, estimates)).toEqual({ classification: 'retail', dealerName: null, linkedEstimateId: 'est-abc' })
  })
  it('never guesses dealer from a name — unmapped id + no link = unknown', () => {
    expect(classifyReceivable({ qbInvoiceId: '5', customerId: '999' }, dealers, estimates).classification).toBe('unknown')
  })
})

describe('Sterling Tuesday→Friday owner-confirmed cash date', () => {
  it('dates an invoice submitted this Tuesday to this Friday', () => {
    // Tue 2026-09-08 invoice, today Wed 2026-09-09 → pay Fri 2026-09-11.
    expect(sterlingExpectedFriday('2026-09-08', new Date('2026-09-09T12:00:00Z'))).toBe('2026-09-11')
  })
  it('does NOT assign Friday when that Friday already passed (overdue/ambiguous → date unknown)', () => {
    // Invoice from 3 weeks ago, still open: its cycle Friday is long past.
    expect(sterlingExpectedFriday('2026-08-18', new Date('2026-09-09T12:00:00Z'))).toBeNull()
  })
  it('does NOT assign a Friday too far in the future to be the current cycle', () => {
    expect(sterlingExpectedFriday('2026-10-06', new Date('2026-09-09T12:00:00Z'))).toBeNull()
  })
  it('returns null for a missing txn date', () => {
    expect(sterlingExpectedFriday(null, new Date('2026-09-09T12:00:00Z'))).toBeNull()
  })
})
