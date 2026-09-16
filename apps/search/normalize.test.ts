import { describe, it, expect } from 'vitest'
import { parseQuery, escapeLike, normalizePhone, normalizeAlnum } from './normalize'

describe('normalize helpers', () => {
  it('normalizePhone strips all punctuation to digits', () => {
    expect(normalizePhone('(254) 555-1234')).toBe('2545551234')
    expect(normalizePhone('254.555.1234')).toBe('2545551234')
    expect(normalizePhone(null)).toBe('')
  })

  it('normalizeAlnum uppercases and drops spaces/hyphens (plate/VIN normalization)', () => {
    expect(normalizeAlnum('abc-123')).toBe('ABC123')
    expect(normalizeAlnum('1hg cm8')).toBe('1HGCM8')
  })

  it('escapeLike literalises LIKE wildcards so they match as data', () => {
    expect(escapeLike('50% off_now')).toBe('50\\% off\\_now')
    expect(escapeLike('a\\b')).toBe('a\\\\b')
  })
})

describe('parseQuery validation', () => {
  it('rejects an over-long query (abusive/malformed) with too_long', () => {
    const r = parseQuery('x'.repeat(101))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('too_long')
  })

  it('treats a too-short query as an empty state, not an error', () => {
    const r = parseQuery('a')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('too_short')
  })

  it('accepts a normal query and produces normalized forms', () => {
    const r = parseQuery('  Honey  Badger ')
    expect(r.ok).toBe(true)
    expect(r.parsed!.raw).toBe('Honey Badger')
    expect(r.parsed!.lower).toBe('honey badger')
    expect(r.parsed!.likeContains).toBe('%Honey Badger%')
    expect(r.parsed!.likePrefix).toBe('Honey Badger%')
  })

  it('strips a money-looking query so it is never a general search key', () => {
    expect(parseQuery('$250').parsed!.raw).toBe('250')
    expect(parseQuery('250 dollars').parsed!.raw).toBe('250')
  })

  it('escapes wildcards inside the LIKE pattern (injection-like input handled as data)', () => {
    const r = parseQuery("100% clean")
    expect(r.ok).toBe(true)
    expect(r.parsed!.likeContains).toBe('%100\\% clean%')
  })

  it("preserves SQL metacharacters as plain data (parameterised — never executed)", () => {
    const r = parseQuery("'; DROP TABLE customers;--")
    expect(r.ok).toBe(true)
    expect(r.parsed!.raw).toContain('DROP TABLE customers')
  })
})

describe('parseQuery classification', () => {
  const kind = (s: string) => parseQuery(s).parsed!.kind
  it('classifies phone / stock / number / vin / text', () => {
    expect(kind('2545551234')).toBe('phone')
    expect(kind('(254) 555-1234')).toBe('phone')
    expect(kind('PS-1234')).toBe('stock')
    expect(kind('1042')).toBe('number')
    expect(kind('1HGCM82633A001234')).toBe('vin')
    expect(kind('A1234')).toBe('vin')
    expect(kind('ceramic coating')).toBe('text')
  })
})
