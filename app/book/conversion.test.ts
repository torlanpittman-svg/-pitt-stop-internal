import { describe, it, expect, vi } from 'vitest'
import { fireBookingConversion } from './conversion'

describe('booking confirmed measurement', () => {
  it('sends nothing when no tag id is configured', () => {
    const gtag = vi.fn()
    expect(fireBookingConversion('PS-ABC123', { gtag }, {})).toBe(0)
    expect(gtag).not.toHaveBeenCalled()
  })
  it('sends nothing when gtag.js is not loaded', () => {
    expect(fireBookingConversion('PS-ABC123', {}, { ga: 'G-1' })).toBe(0)
  })
  it('sends one GA4 booking_confirmed event keyed by the appointment reference', () => {
    const gtag = vi.fn()
    expect(fireBookingConversion('PS-ABC123', { gtag }, { ga: 'G-1' })).toBe(1)
    expect(gtag).toHaveBeenCalledWith('event', 'booking_confirmed', { send_to: 'G-1', transaction_id: 'PS-ABC123' })
  })
  it('also sends the direct Google Ads conversion when that is configured', () => {
    const gtag = vi.fn()
    expect(fireBookingConversion('PS-1', { gtag }, { ga: 'G-1', sendTo: 'AW-1/x' })).toBe(2)
    expect(gtag).toHaveBeenLastCalledWith('event', 'conversion', { send_to: 'AW-1/x', transaction_id: 'PS-1' })
  })
  it('swallows a throwing gtag so the booking flow never breaks', () => {
    const gtag = vi.fn(() => { throw new Error('boom') })
    expect(fireBookingConversion('PS-1', { gtag }, { ga: 'G-1' })).toBe(0)
  })
})
