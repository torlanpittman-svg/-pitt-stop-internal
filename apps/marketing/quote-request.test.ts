import { describe, it, expect } from 'vitest'
import { parseQuoteRequest, quoteSubject, quoteEmailText, quoteInbox, DEFAULT_QUOTE_INBOX, normalizeRequestKey, quotePayloadHash } from './quote-request'
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
  it('rejects inherited object keys as services (Object.hasOwn, not `in`)', () => {
    for (const service of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      const r = parseQuoteRequest({ ...good, service })
      expect(r.ok, `service=${service} must not validate`).toBe(false)
      if (!r.ok) expect(r.errors.service).toBe('Choose a service.')
    }
  })
  it('limits photos to MAX_PHOTOS (4) small JPEG/PNG/WebP images', () => {
    const png = { name: 'a.png', contentType: 'image/png', contentBase64: 'iVBORw0KGgo=' }
    const ok = parseQuoteRequest({ ...good, photos: [png, png] }); expect(ok.ok).toBe(true)
    const four = parseQuoteRequest({ ...good, photos: [png, png, png, png] }); expect(four.ok).toBe(true)
    const many = parseQuoteRequest({ ...good, photos: [png, png, png, png, png] }); expect(many.ok).toBe(false)
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

describe('request key + payload fingerprint', () => {
  it('accepts a browser UUID and the non-crypto fallback, rejects everything else', () => {
    expect(normalizeRequestKey('d3b07384-d9a0-4c97-9a23-8f63e1a2b4c5')).toBe('d3b07384-d9a0-4c97-9a23-8f63e1a2b4c5')
    expect(normalizeRequestKey(' qk-mh3x1a2b-0a1b2c3d4e ')).toBe('qk-mh3x1a2b-0a1b2c3d4e')
    expect(normalizeRequestKey('short')).toBeNull()
    expect(normalizeRequestKey('x'.repeat(65))).toBeNull()
    expect(normalizeRequestKey('has spaces in the middle!')).toBeNull()
    expect(normalizeRequestKey(42)).toBeNull()
    expect(normalizeRequestKey(undefined)).toBeNull()
  })
  it('hash is stable for the same payload and changes with any field including photos', () => {
    const a = parseQuoteRequest(good); if (!a.ok) throw new Error('parse')
    const b = parseQuoteRequest(good); if (!b.ok) throw new Error('parse')
    expect(quotePayloadHash(a.req)).toBe(quotePayloadHash(b.req))
    const edited = parseQuoteRequest({ ...good, message: 'Deep scratches' }); if (!edited.ok) throw new Error('parse')
    expect(quotePayloadHash(edited.req)).not.toBe(quotePayloadHash(a.req))
    const withPhoto = parseQuoteRequest({ ...good, photos: [{ name: 'a.png', contentType: 'image/png', contentBase64: 'iVBORw0KGgo=' }] }); if (!withPhoto.ok) throw new Error('parse')
    expect(quotePayloadHash(withPhoto.req)).not.toBe(quotePayloadHash(a.req))
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

describe('insurance-restoration fields', () => {
  const NOW = new Date('2026-11-07T18:00:00Z')
  const rest = { ...good, service: 'overspray', claimStatus: 'filed', incidentDate: '2026-11-01' }
  it('accepts a restoration damage type with a known claim status and a past incident date', () => {
    const r = parseQuoteRequest(rest, NOW); if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.req.service).toBe('overspray'); expect(r.req.claimStatus).toBe('filed'); expect(r.req.incidentDate).toBe('2026-11-01')
    for (const svc of ['vandalism', 'water_damage', 'glass']) expect(parseQuoteRequest({ ...rest, service: svc }, NOW).ok).toBe(true)
  })
  it('unknown claim status becomes "not answered" (null), never an error and never a made-up value', () => {
    const r = parseQuoteRequest({ ...rest, claimStatus: 'covered_for_sure' }, NOW); if (!r.ok) throw new Error('parse')
    expect(r.req.claimStatus).toBeNull()
    const blank = parseQuoteRequest({ ...rest, claimStatus: '' }, NOW); if (!blank.ok) throw new Error('parse')
    expect(blank.req.claimStatus).toBeNull()
  })
  it('rejects a future, impossible, malformed or ancient incident date; blank is fine', () => {
    expect(parseQuoteRequest({ ...rest, incidentDate: '2026-11-08' }, NOW).ok).toBe(false)
    expect(parseQuoteRequest({ ...rest, incidentDate: '2026-02-30' }, NOW).ok).toBe(false)
    expect(parseQuoteRequest({ ...rest, incidentDate: '11/01/2026' }, NOW).ok).toBe(false)
    expect(parseQuoteRequest({ ...rest, incidentDate: '2019-01-01' }, NOW).ok).toBe(false)
    const blank = parseQuoteRequest({ ...rest, incidentDate: '' }, NOW); if (!blank.ok) throw new Error('parse')
    expect(blank.req.incidentDate).toBe('')
    const today = parseQuoteRequest({ ...rest, incidentDate: '2026-11-07' }, NOW); expect(today.ok).toBe(true)
  })
  it('claim status and incident date are DROPPED for detailing services (a stale answer cannot attach to a ceramic quote)', () => {
    const r = parseQuoteRequest({ ...good, claimStatus: 'filed', incidentDate: '2026-11-01' }, NOW); if (!r.ok) throw new Error('parse')
    expect(r.req.claimStatus).toBeNull(); expect(r.req.incidentDate).toBe('')
    // and a bad date on a detailing service is not even an error — the field does not exist for it
    expect(parseQuoteRequest({ ...good, incidentDate: 'garbage' }, NOW).ok).toBe(true)
  })
  it('the payload hash covers claim status and incident date, so a changed answer under a reused key conflicts', () => {
    const a = parseQuoteRequest(rest, NOW); const b = parseQuoteRequest({ ...rest, claimStatus: 'approved' }, NOW); const c = parseQuoteRequest({ ...rest, incidentDate: '2026-10-31' }, NOW)
    if (!a.ok || !b.ok || !c.ok) throw new Error('parse')
    expect(quotePayloadHash(a.req)).not.toBe(quotePayloadHash(b.req))
    expect(quotePayloadHash(a.req)).not.toBe(quotePayloadHash(c.req))
  })
  it('the shop email names the damage type, the customer’s claim answer and the no-promises reminder; subject says ESTIMATE', () => {
    const r = parseQuoteRequest(rest, NOW); if (!r.ok) throw new Error('parse')
    const text = quoteEmailText(r.req, { leadId: 'L1', source: 'google_ads', receivedAt: NOW })
    expect(quoteSubject(r.req)).toMatch(/Paint overspray removal ESTIMATE request/)
    expect(text).toContain('Claim filed, waiting on the adjuster'); expect(text).toContain('2026-11-01'); expect(text).toMatch(/Do not promise coverage/)
    const plain = parseQuoteRequest(good, NOW); if (!plain.ok) throw new Error('parse')
    expect(quoteEmailText(plain.req, { leadId: 'L1', source: 'website', receivedAt: NOW })).not.toMatch(/Insurance:/)
    expect(quoteSubject(plain.req)).toMatch(/quote request/)
  })
})
