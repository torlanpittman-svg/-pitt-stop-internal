import { describe, it, expect } from 'vitest'
import { normalizeReferralSource, referralSourceLabel, REFERRAL_SOURCES, REFERRAL_SOURCE_PLATFORMS } from './referral-source'

describe('referral source (self-reported "how did you hear about us")', () => {
  it('accepts only the known keys, case-insensitively', () => {
    for (const r of REFERRAL_SOURCES) expect(normalizeReferralSource(r.key)).toBe(r.key)
    expect(normalizeReferralSource(' Google ')).toBe('google')
  })
  it('accepts and labels the booking page\'s platform keys without adding them to the counter picker', () => {
    for (const r of REFERRAL_SOURCE_PLATFORMS) expect(normalizeReferralSource(r.key)).toBe(r.key)
    expect(referralSourceLabel('instagram')).toBe('Instagram')
    expect(REFERRAL_SOURCES.map((r) => r.key)).not.toContain('facebook')
  })
  it('turns blank, unknown or non-string answers into null (not answered)', () => {
    expect(normalizeReferralSource('')).toBeNull()
    expect(normalizeReferralSource('gclid')).toBeNull()
    expect(normalizeReferralSource(undefined)).toBeNull()
    expect(normalizeReferralSource(42)).toBeNull()
  })
  it('labels unknown stored keys verbatim and null as a dash', () => {
    expect(referralSourceLabel('google')).toBe('Google (search or Maps)')
    expect(referralSourceLabel('legacy')).toBe('legacy')
    expect(referralSourceLabel(null)).toBe('—')
  })
})
