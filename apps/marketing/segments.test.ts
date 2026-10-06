import { describe, it, expect } from 'vitest'
import {
  matchesSegment, applySegment, estimateSegment, resolveSegmentCriteria,
  NAMED_SEGMENTS, getNamedSegment, type ContactAggregate,
} from './segments'

const NOW = new Date('2026-10-06T00:00:00Z').getTime()
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000)

function contact(over: Partial<ContactAggregate> = {}): ContactAggregate {
  return {
    customerId: 'c1', name: 'Test', phone: '5125551234', email: 'a@b.com',
    lastVisitAt: daysAgo(30), totalVisits: 1, lifetimeRevenueCents: 50_000, avgTicketCents: 50_000,
    categories: [], smsEligible: true, emailEligible: true, smsConsent: true, unsubscribed: false, ...over,
  }
}

describe('segment matching', () => {
  it('inactive gate requires a last visit old enough', () => {
    const c = { criteria: { minDaysSinceVisit: 180 } } as const
    expect(matchesSegment(contact({ lastVisitAt: daysAgo(200) }), c.criteria, NOW)).toBe(true)
    expect(matchesSegment(contact({ lastVisitAt: daysAgo(100) }), c.criteria, NOW)).toBe(false)
    expect(matchesSegment(contact({ lastVisitAt: null }), c.criteria, NOW)).toBe(false)
  })

  it('premium upsell: has one category and lacks another', () => {
    const crit = NAMED_SEGMENTS.paint_without_ceramic.criteria
    expect(matchesSegment(contact({ categories: ['paint_correction'] }), crit, NOW)).toBe(true)
    expect(matchesSegment(contact({ categories: ['paint_correction', 'ceramic'] }), crit, NOW)).toBe(false)
    expect(matchesSegment(contact({ categories: [] }), crit, NOW)).toBe(false)
  })

  it('high value uses the lifetime revenue threshold', () => {
    const crit = NAMED_SEGMENTS.high_value.criteria
    expect(matchesSegment(contact({ lifetimeRevenueCents: 150_000 }), crit, NOW)).toBe(true)
    expect(matchesSegment(contact({ lifetimeRevenueCents: 50_000 }), crit, NOW)).toBe(false)
  })

  it('requireContactable excludes unsubscribed and unreachable contacts', () => {
    const crit = { requireContactable: true }
    expect(matchesSegment(contact(), crit, NOW)).toBe(true)
    expect(matchesSegment(contact({ unsubscribed: true }), crit, NOW)).toBe(false)
    expect(matchesSegment(contact({ phone: null, email: null }), crit, NOW)).toBe(false)
  })

  it('channel eligibility respects consent AND a present address', () => {
    expect(matchesSegment(contact({ smsEligible: false }), { requireSmsEligible: true }, NOW)).toBe(false)
    expect(matchesSegment(contact({ phone: null }), { requireSmsEligible: true }, NOW)).toBe(false)
    expect(matchesSegment(contact({ email: null }), { requireEmailEligible: true }, NOW)).toBe(false)
  })

  it('requireSmsConsent: a phone number is NOT consent — only proven opt-in qualifies', () => {
    expect(matchesSegment(contact({ smsConsent: true }), { requireSmsConsent: true }, NOW)).toBe(true)
    expect(matchesSegment(contact({ smsConsent: false }), { requireSmsConsent: true }, NOW)).toBe(false)
    expect(matchesSegment(contact({ smsConsent: true, phone: null }), { requireSmsConsent: true }, NOW)).toBe(false)
  })

  it('SMS reach estimate counts only consented contacts', () => {
    const contacts = [
      contact({ customerId: 'a', smsConsent: true }),
      contact({ customerId: 'b', smsConsent: false }), // has phone, no consent → not reachable by SMS
    ]
    const est = estimateSegment(contacts, { requireContactable: true }, NOW)
    expect(est.smsReachable).toBe(1)
  })
})

describe('segment estimate', () => {
  it('counts total and per-channel reachability', () => {
    const contacts = [
      contact({ customerId: 'a', categories: ['paint_correction'] }),
      contact({ customerId: 'b', categories: ['paint_correction'], email: null }),           // sms only
      contact({ customerId: 'c', categories: ['paint_correction'], unsubscribed: true }),     // unreachable
      contact({ customerId: 'd', categories: ['paint_correction', 'ceramic'] }),              // excluded (has ceramic)
    ]
    const est = estimateSegment(contacts, NAMED_SEGMENTS.paint_without_ceramic.criteria, NOW)
    expect(est.total).toBe(2)         // a + b (c excluded by requireContactable, d by ceramic)
    expect(est.smsReachable).toBe(2)  // a + b
    expect(est.emailReachable).toBe(1) // a only
  })
})

describe('segment resolution', () => {
  it('resolves a named key to its criteria', () => {
    expect(resolveSegmentCriteria('inactive_365')).toEqual(NAMED_SEGMENTS.inactive_365.criteria)
  })
  it('falls back to custom criteria or a safe contactable default', () => {
    expect(resolveSegmentCriteria(null, { minVisits: 3 })).toEqual({ minVisits: 3 })
    expect(resolveSegmentCriteria('nonexistent')).toEqual({ requireContactable: true })
  })
  it('every named segment requires contactability (no blind blasting)', () => {
    for (const s of Object.values(NAMED_SEGMENTS)) {
      expect(s.criteria.requireContactable).toBe(true)
    }
  })
  it('getNamedSegment returns null for unknown keys', () => {
    expect(getNamedSegment('nope')).toBeNull()
  })
})

describe('applySegment', () => {
  it('filters a list by criteria', () => {
    const list = [contact({ customerId: 'x', totalVisits: 1 }), contact({ customerId: 'y', totalVisits: 3 })]
    expect(applySegment(list, { minVisits: 2 }, NOW).map((c) => c.customerId)).toEqual(['y'])
  })
})
