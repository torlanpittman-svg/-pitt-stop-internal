import { describe, expect, it } from 'vitest'
import {
  enumValue, optionalEnumValue, ymdDate, optionalYmdDate, nonNegativeCents, optionalCents,
  nonNegativeInt, uuidValue, optionalUuid, requiredText, MarketingInputError,
} from './validation'

const STATUSES = ['new', 'booked', 'won'] as const
const UUID = '123e4567-e89b-12d3-a456-426614174000'

describe('enumValue', () => {
  it('accepts a known value and rejects an unknown one', () => {
    expect(enumValue('booked', STATUSES, 'status')).toBe('booked')
    expect(() => enumValue('nope', STATUSES, 'status')).toThrow(MarketingInputError)
  })
  it('optional returns null for empty and validates otherwise', () => {
    expect(optionalEnumValue(null, STATUSES, 'status')).toBeNull()
    expect(() => optionalEnumValue('bad', STATUSES, 'status')).toThrow(MarketingInputError)
  })
})

describe('ymdDate', () => {
  it('parses a real date', () => {
    expect(ymdDate('2026-10-04', 'date').toISOString().slice(0, 10)).toBe('2026-10-04')
  })
  it('rejects malformed and impossible dates', () => {
    expect(() => ymdDate('10/04/2026', 'date')).toThrow(MarketingInputError)
    expect(() => ymdDate('2026-13-40', 'date')).toThrow(MarketingInputError)
    expect(() => ymdDate('', 'date')).toThrow(MarketingInputError)
  })
  it('optional allows blank', () => {
    expect(optionalYmdDate('', 'date')).toBeNull()
    expect(optionalYmdDate(null, 'date')).toBeNull()
  })
})

describe('amounts (strict)', () => {
  it('parses a plain dollar amount (optional leading $) to cents', () => {
    expect(nonNegativeCents('149', 'spend')).toBe(14900)
    expect(nonNegativeCents('149.50', 'spend')).toBe(14950)
    expect(nonNegativeCents('$149.50', 'spend')).toBe(14950)
    expect(nonNegativeCents('  12.5 ', 'spend')).toBe(1250)
  })
  it('rejects malformed, grouped, signed, exponent, multi-dot, and letter-bearing amounts', () => {
    for (const bad of ['1abc', '1.2.3', '1e3', '1,000', '-5', 'abc', '1.234', '', '$']) {
      expect(() => nonNegativeCents(bad, 'spend'), bad).toThrow(MarketingInputError)
    }
  })
  it('rejects amounts that would overflow an int32 cents column', () => {
    expect(() => nonNegativeCents('99999999', 'spend')).toThrow(MarketingInputError) // 9,999,999,900 cents > int32
  })
  it('optional cents returns null for blank', () => {
    expect(optionalCents('', 'revenue')).toBeNull()
    expect(optionalCents('12.5', 'revenue')).toBe(1250)
  })
  it('nonNegativeInt rejects non-numeric/sign/decimal/exponent, allows blank as 0, caps at int32', () => {
    expect(nonNegativeInt('42', 'clicks')).toBe(42)
    expect(nonNegativeInt('', 'clicks')).toBe(0)
    for (const bad of ['-3', '12x', '1.5', '1e3', '1,000']) {
      expect(() => nonNegativeInt(bad, 'clicks'), bad).toThrow(MarketingInputError)
    }
    expect(() => nonNegativeInt('3000000000', 'clicks')).toThrow(MarketingInputError) // > int32
  })
})

describe('ids + text', () => {
  it('validates uuids', () => {
    expect(uuidValue(UUID, 'id')).toBe(UUID)
    expect(() => uuidValue('not-a-uuid', 'id')).toThrow(MarketingInputError)
    expect(optionalUuid('', 'id')).toBeNull()
    expect(() => optionalUuid('xyz', 'id')).toThrow(MarketingInputError)
  })
  it('requires non-empty text and enforces max length', () => {
    expect(requiredText('  hello  ', 'name')).toBe('hello')
    expect(() => requiredText('   ', 'name')).toThrow(MarketingInputError)
    expect(() => requiredText('x'.repeat(10), 'name', 5)).toThrow(MarketingInputError)
  })
})
