import { describe, it, expect, vi } from 'vitest'
import { fireQuoteConversion } from './conversion'

describe('quote_requested measurement', () => {
  it('sends nothing when no tag id is configured or gtag.js is not loaded', () => {
    const gtag = vi.fn()
    expect(fireQuoteConversion({ leadId: 'L1', service: 'overspray' }, { gtag }, {})).toBe(0)
    expect(fireQuoteConversion({ leadId: 'L1', service: 'overspray' }, {}, { ga: 'G-1' })).toBe(0)
    expect(gtag).not.toHaveBeenCalled()
  })
  it('sends one GA4 event carrying only the service type and the opaque lead id', () => {
    const gtag = vi.fn()
    expect(fireQuoteConversion({ leadId: 'L1', service: 'vandalism' }, { gtag }, { ga: 'G-1' })).toBe(1)
    expect(gtag).toHaveBeenCalledWith('event', 'quote_requested', { send_to: 'G-1', transaction_id: 'L1', service_type: 'vandalism' })
    const [, , params] = gtag.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(Object.keys(params).sort()).toEqual(['send_to', 'service_type', 'transaction_id'])
  })
  it('never fires on an idempotent replay (one lead = one conversion)', () => {
    const gtag = vi.fn()
    expect(fireQuoteConversion({ leadId: 'L1', service: 'glass', replayed: true }, { gtag }, { ga: 'G-1', sendTo: 'AW-1/x' })).toBe(0)
    expect(gtag).not.toHaveBeenCalled()
  })
  it('also sends the direct Google Ads conversion when configured, and swallows a throwing gtag', () => {
    const gtag = vi.fn()
    expect(fireQuoteConversion({ leadId: 'L1', service: 'water_damage' }, { gtag }, { ga: 'G-1', sendTo: 'AW-1/x' })).toBe(2)
    expect(gtag).toHaveBeenLastCalledWith('event', 'conversion', { send_to: 'AW-1/x', transaction_id: 'L1', service_type: 'water_damage' })
    const boom = vi.fn(() => { throw new Error('boom') })
    expect(fireQuoteConversion({ leadId: 'L1', service: 'glass' }, { gtag: boom }, { ga: 'G-1' })).toBe(0)
  })
})
