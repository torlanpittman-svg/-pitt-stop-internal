/**
 * Pure recipient-set normalization for the standalone-estimate send. No server/DB imports — this runs in
 * the same form in the browser and on the server. A recipient SET (any order, any duplicates, any case) must
 * collapse to one deterministic list so it is one send identity; invalid/placeholder-shaped/over-bound input
 * is rejected here before anything reaches QuickBooks.
 */
import { describe, it, expect } from 'vitest'
import { normalizeRecipients, normalizeForCompare, sameRecipientSet, recipientErrorMessage, MAX_RECIPIENTS } from './recipients'

describe('normalizeRecipients', () => {
  it('keeps a single address (the saved-contact fallback shape)', () => {
    expect(normalizeRecipients(['Customer@Shop.NET'])).toEqual({ ok: true, list: ['customer@shop.net'], joined: 'customer@shop.net' })
  })

  it('trims, drops blanks, lowercases, de-duplicates case-insensitively, and sorts deterministically', () => {
    const r = normalizeRecipients([' B@x.com ', 'a@x.com', '', 'A@X.com', '  '])
    expect(r).toEqual({ ok: true, list: ['a@x.com', 'b@x.com'], joined: 'a@x.com,b@x.com' })
  })

  it('is order- and duplicate-independent — the same SET yields the same list and join', () => {
    const a = normalizeRecipients(['a@x.com', 'b@x.com'])
    const b = normalizeRecipients(['B@x.com', 'a@x.com', 'a@x.com'])
    expect(a).toEqual(b)
  })

  it('rejects an empty / all-blank list', () => {
    expect(normalizeRecipients([])).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeRecipients(['', '   '])).toEqual({ ok: false, reason: 'empty' })
  })

  it('rejects malformed addresses and whitespace / separators inside an entry', () => {
    for (const bad of ['not-an-email', 'a@', '@x.com', 'a b@x.com', 'a@x.com,b@x.com', 'a@x.com;b@x.com']) {
      expect(normalizeRecipients([bad])).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  it('rejects header-injection attempts before anything is sent', () => {
    expect(normalizeRecipients(['ok@x.com\nBcc: evil@x.com'])).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeRecipients(['ok@x.com%0aBcc:evil@x.com'])).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeRecipients(['ok@x.com\r\nSubject: x'])).toEqual({ ok: false, reason: 'invalid' })
  })

  it('enforces the address-count cap on the de-duplicated set', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `user${i}@x.com`)
    expect(normalizeRecipients(many)).toEqual({ ok: false, reason: 'too_many' })
    // Duplicates that collapse under the cap are fine.
    const dupes = Array.from({ length: MAX_RECIPIENTS + 5 }, () => 'a@x.com')
    expect(normalizeRecipients(dupes)).toEqual({ ok: true, list: ['a@x.com'], joined: 'a@x.com' })
  })

  it('enforces the joined-length cap', () => {
    // Valid addresses (local ≤64, labels ≤63) that are individually long: 10 of them exceed 1000 joined
    // chars while staying within the address-count cap, so the length guard — not the count guard — fires.
    const long = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `${'a'.repeat(58)}${i}@${'b'.repeat(50)}.example.com`)
    expect(normalizeRecipients(long)).toEqual({ ok: false, reason: 'too_long' })
  })
})

describe('normalizeForCompare / sameRecipientSet', () => {
  it('canonicalizes a comma-separated QuickBooks address string ignoring spacing/case/order', () => {
    expect(normalizeForCompare(' B@x.com , a@x.com ')).toEqual(['a@x.com', 'b@x.com'])
    expect(normalizeForCompare(null)).toEqual([])
    expect(normalizeForCompare('')).toEqual([])
  })

  it('matches a QuickBooks-returned list to a normalized set regardless of formatting', () => {
    expect(sameRecipientSet('B@x.com, a@x.com', ['a@x.com', 'b@x.com'])).toBe(true)
    expect(sameRecipientSet('a@x.com', ['a@x.com', 'b@x.com'])).toBe(false)
    expect(sameRecipientSet('a@x.com,c@x.com', ['a@x.com', 'b@x.com'])).toBe(false)
  })
})

describe('recipientErrorMessage', () => {
  it('maps each reason to a human message', () => {
    expect(recipientErrorMessage('empty')).toMatch(/at least one/i)
    expect(recipientErrorMessage('invalid')).toMatch(/valid/i)
    expect(recipientErrorMessage('too_many')).toMatch(new RegExp(String(MAX_RECIPIENTS)))
    expect(recipientErrorMessage('too_long')).toMatch(/characters/i)
  })
})
