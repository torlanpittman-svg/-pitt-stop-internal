import { describe, it, expect } from 'vitest'
import { normalizeReferralSource } from '@/apps/quick-entry/referral-source'
import {
  BOOKING_REFERRAL_OPTIONS, BOOKING_REFERRAL_PLACEHOLDER, normalizeBookingReferral, validateBookingReferral,
  bookingReferralLabel, referralSummary, REFERRAL_REQUIRED_MESSAGE, REFERRAL_DETAIL_MESSAGE,
} from './referral'

describe('booking "How did you hear about us?"', () => {
  it('offers exactly the requested options, in order, behind an unselected placeholder', () => {
    expect(BOOKING_REFERRAL_PLACEHOLDER).toBe('Select an option')
    expect(BOOKING_REFERRAL_OPTIONS.map((o) => o.label)).toEqual([
      'Google Search / Google Maps', 'Facebook', 'Instagram', 'Friend or Family', 'Returning Customer', 'Drove By / Saw Our Sign', 'Other',
    ])
    // Every option is a key of the shared retail vocabulary, so one report covers bookings, Quick Entry and quotes.
    for (const o of BOOKING_REFERRAL_OPTIONS) expect(normalizeReferralSource(o.key)).toBe(o.key)
  })

  it('requires a selection for public bookings and nothing for staff entries', () => {
    expect(validateBookingReferral({ source: '', detail: '' }, { required: true })).toEqual({ referral: REFERRAL_REQUIRED_MESSAGE })
    expect(validateBookingReferral({ source: undefined }, { required: true })).toEqual({ referral: REFERRAL_REQUIRED_MESSAGE })
    expect(validateBookingReferral({ source: '', detail: '' }, { required: false })).toEqual({})
    expect(validateBookingReferral({ source: 'google' }, { required: true })).toEqual({})
  })

  it('"Other" needs nonblank text, whoever is entering it', () => {
    expect(validateBookingReferral({ source: 'other', detail: '' }, { required: true })).toEqual({ referralDetail: REFERRAL_DETAIL_MESSAGE })
    expect(validateBookingReferral({ source: 'other', detail: '   ' }, { required: false })).toEqual({ referralDetail: REFERRAL_DETAIL_MESSAGE })
    expect(validateBookingReferral({ source: 'other', detail: 'Church bulletin' }, { required: true })).toEqual({})
  })

  it('normalizes: unknown or non-booking keys count as not answered; detail is trimmed, capped and dropped without a source', () => {
    expect(normalizeBookingReferral({ source: ' Facebook ', detail: '' })).toEqual({ source: 'facebook', detail: '' })
    expect(normalizeBookingReferral({ source: 'tiktok', detail: 'x' })).toEqual({ source: null, detail: '' })
    expect(normalizeBookingReferral({ source: 'social', detail: '' })).toEqual({ source: null, detail: '' }) // retail-only key, not offered online
    expect(normalizeBookingReferral({ source: 'gclid' })).toEqual({ source: null, detail: '' })
    expect(normalizeBookingReferral({ source: 'other', detail: `  ${'a'.repeat(200)}  ` }).detail).toHaveLength(120)
    expect(normalizeBookingReferral({ source: '', detail: 'orphan text' })).toEqual({ source: null, detail: '' })
  })

  it('labels for staff screens', () => {
    expect(bookingReferralLabel('drive_by')).toBe('Drove By / Saw Our Sign')
    expect(bookingReferralLabel('business')).toBe('Dealer or business referral') // shared label for a key the booking page does not offer
    expect(bookingReferralLabel(null)).toBe('—')
    expect(referralSummary({ referralSource: 'other', referralDetail: 'Church bulletin' })).toBe('Other — Church bulletin')
    expect(referralSummary({ referralSource: 'instagram', referralDetail: null })).toBe('Instagram')
    expect(referralSummary({ referralSource: null, referralDetail: null })).toBe('')
  })
})
