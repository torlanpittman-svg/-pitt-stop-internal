import { describe, it, expect } from 'vitest'
import { parseQuoteRequest, quoteSubject, quoteEmailText, quoteInbox, DEFAULT_QUOTE_INBOX } from './quote-request'
import { publicBookingRoute } from '@/apps/appointments/public-host'

const good = { service: 'ceramic', name: 'Jane Doe', phone: '(979) 555-0199', email: 'Jane@Example.com', vehicleYear: '2020', vehicleMake: 'Cadillac', vehicleModel: 'XT6', message: 'Light swirls', photos: [] }

describe('quote request parsing', () => {
  it('accepts a complete request and normalises phone/email', () => {
    const r = parseQuoteRequest(good)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.req.email).toBe('jane@example.com'); expect(r.req.phone).toMatch(/979/); expect(r.req.service).toBe('ceramic'); expect(r.req.referralSource).toBeNull(); expect(r.req.referralDetail).toBe('') }
  })
  it('keeps the optional self-reported referral answer, fail-closed to known keys, detail only with a source', () => {
    const a = parseQuoteRequest({ ...good, referralSource: 'Google', referralDetail: 'ignored' }); if (!a.ok) throw new Error('parse')
    expect(a.req.referralSource).toBe('google'); expect(a.req.referralDetail).toBe('ignored')
    const b = parseQuoteRequest({ ...good, referralSource: 'tv', referralDetail: 'x' }); if (!b.ok) throw new Error('parse')
    expect(b.req.referralSource).toBeNull(); expect(b.req.referralDetail).toBe('')
    const c = parseQuoteRequest({ ...good, referralSource: 'other', referralDetail: 'A'.repeat(200) }); if (!c.ok) throw new Error('parse')
    expect(c.req.referralDetail).toHaveLength(120)
  })
  it('rejects a bad service, missing contact and bad year with per-field errors', () => {
    const r = parseQuoteRequest({ ...good, service: 'ppf', phone: '12', email: 'nope', vehicleYear: '20' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['email', 'phone', 'service', 'vehicleYear'])
  })
  it('limits photos to 2 small JPEG/PNG/WebP images', () => {
    const png = { name: 'a.png', contentType: 'image/png', contentBase64: 'iVBORw0KGgo=' }
    const ok = parseQuoteRequest({ ...good, photos: [png, png] }); expect(ok.ok).toBe(true)
    const many = parseQuoteRequest({ ...good, photos: [png, png, png] }); expect(many.ok).toBe(false)
    const pdf = parseQuoteRequest({ ...good, photos: [{ ...png, contentType: 'application/pdf' }] }); expect(pdf.ok).toBe(false)
    const huge = parseQuoteRequest({ ...good, photos: [{ ...png, contentBase64: 'A'.repeat(1_700_000) }] }); expect(huge.ok).toBe(false)
  })
})

describe('quote email', () => {
  it('has a useful subject and body with the customer details', () => {
    const r = parseQuoteRequest(good); if (!r.ok) throw new Error('parse')
    expect(quoteSubject(r.req)).toBe('Ceramic coating quote request — 2020 Cadillac XT6 — Jane Doe')
    const text = quoteEmailText(r.req, { leadId: 'L1', source: 'google_ads', receivedAt: new Date('2026-11-05T18:00:00Z') })
    expect(text).toContain('jane@example.com'); expect(text).toContain('Light swirls'); expect(text).toContain('google_ads')
    expect(text).toContain('Heard about us (customer\'s own answer): (not answered)')
    const r2 = parseQuoteRequest({ ...good, referralSource: 'other', referralDetail: 'church bulletin' }); if (!r2.ok) throw new Error('parse')
    expect(quoteEmailText(r2.req, { leadId: 'L2', source: 'website', receivedAt: new Date() })).toContain('Other — church bulletin')
  })
  it('delivers to the shop group unless QUOTE_INBOX overrides it', () => {
    expect(quoteInbox({} as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_QUOTE_INBOX)
    expect(quoteInbox({ QUOTE_INBOX: ' x@pittstopbcs.com ' } as unknown as NodeJS.ProcessEnv)).toBe('x@pittstopbcs.com')
  })
})

describe('booking host exposure', () => {
  it('serves the quote page and its POST, and nothing else new', () => {
    expect(publicBookingRoute('/quote', 'GET')).toBe('allow')
    expect(publicBookingRoute('/api/quote', 'POST')).toBe('allow')
    expect(publicBookingRoute('/api/quote', 'GET')).toBe('deny')
    expect(publicBookingRoute('/quote/anything', 'GET')).toBe('deny')
  })
})
