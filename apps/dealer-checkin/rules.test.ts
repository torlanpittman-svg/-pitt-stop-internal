import { describe, it, expect } from 'vitest'
import {
  extractStockPrefix,
  formatLineDescription,
  decidePricing,
  selectAppendableInvoice,
  isDuplicateStock,
  normalizeStock,
  clampText,
  normalizeYear,
  STANDARD_RATE,
  NEW_STERLING_AUTO_RATE,
} from './rules'

describe('normalizeYear (prevents year varchar(4) overflow)', () => {
  it('passes a clean 4-digit year through', () => {
    expect(normalizeYear('2026')).toBe('2026')
    expect(normalizeYear(' 2026 ')).toBe('2026')
  })
  it('extracts a plausible year from a merged OCR value', () => {
    expect(normalizeYear('20268')).toBe('2026')   // the failing production case
    expect(normalizeYear('2026 Subaru')).toBe('2026')
  })
  it('falls back to the first 4 digits, else null', () => {
    expect(normalizeYear('88991')).toBe('8899')
    expect(normalizeYear('')).toBeNull()
    expect(normalizeYear(null)).toBeNull()
    expect(normalizeYear('abcd')).toBeNull()
  })
})

describe('clampText (prevents varchar length overflow)', () => {
  it('truncates over-length values to the column limit', () => {
    expect(clampText('X'.repeat(120), 100)).toHaveLength(100)
  })
  it('leaves within-limit and null values untouched', () => {
    expect(clampText('Subaru', 100)).toBe('Subaru')
    expect(clampText(null, 100)).toBeNull()
    expect(clampText(undefined, 100)).toBeNull()
  })
})

describe('extractStockPrefix', () => {
  it('takes the first letter, uppercased', () => {
    expect(extractStockPrefix('K518991')).toBe('K')
    expect(extractStockPrefix('up003483')).toBe('U')
    expect(extractStockPrefix('TJ285137')).toBe('T')
    expect(extractStockPrefix(' s515324')).toBe('S')
  })
  it('returns null for empty/blank/non-alpha starts', () => {
    expect(extractStockPrefix(null)).toBeNull()
    expect(extractStockPrefix('')).toBeNull()
    expect(extractStockPrefix('123456')).toBeNull()
  })
})

describe('formatLineDescription', () => {
  it('matches the real QB format YEAR MAKE MODEL COLOR #STOCK', () => {
    expect(formatLineDescription({ year: '2021', make: 'Honda', model: 'Civic', color: 'Gray', stockNumber: 'K518991' }))
      .toBe('2021 Honda Civic Gray #K518991')
    expect(formatLineDescription({ year: '2026', make: 'Subaru', model: 'Forester', color: 'River Rock', stockNumber: 'UP003483' }))
      .toBe('2026 Subaru Forester River Rock #UP003483')
  })
  it('drops empty segments (stockless tag)', () => {
    expect(formatLineDescription({ make: 'VW', model: 'Atlas', color: 'Blue', stockNumber: null }))
      .toBe('VW Atlas Blue')
  })
  it('falls back to Unknown Vehicle when no year/make/model', () => {
    expect(formatLineDescription({ color: 'Blue' })).toBe('Unknown Vehicle Blue')
  })
})

describe('decidePricing', () => {
  it('no signal → no prompt, default $200', () => {
    const d = decidePricing({ stockNumber: 'K518991', tagColor: 'yellow' })
    expect(d.promptRequired).toBe(false)
    expect(d.defaultRate).toBe(STANDARD_RATE)
    expect(d.signals).toHaveLength(0)
  })
  it('T prefix → prompt required', () => {
    const d = decidePricing({ stockNumber: 'T285137', tagColor: 'yellow' })
    expect(d.promptRequired).toBe(true)
    expect(d.signals).toContain('stock prefix T')
    expect(d.newVehicleRate).toBe(NEW_STERLING_AUTO_RATE)
  })
  it('white tag → prompt required even without T', () => {
    const d = decidePricing({ stockNumber: 'K999', tagColor: 'white' })
    expect(d.promptRequired).toBe(true)
    expect(d.signals).toContain('white dealer tag')
  })
  it('never auto-selects $125 (default stays $200 even when prompted)', () => {
    const d = decidePricing({ stockNumber: 'T1', tagColor: 'white' })
    expect(d.defaultRate).toBe(STANDARD_RATE)
    expect(d.signals).toHaveLength(2)
  })
  it('S prefix (Sterling Auto Group, used vehicle) does NOT prompt', () => {
    // regression: only a T prefix or white tag signals a new vehicle
    const d = decidePricing({ stockNumber: 'S515324', tagColor: 'yellow' })
    expect(d.promptRequired).toBe(false)
    expect(d.signals).toHaveLength(0)
  })
  it('tag color match is case-insensitive', () => {
    expect(decidePricing({ stockNumber: 'K1', tagColor: 'WHITE' }).promptRequired).toBe(true)
  })
})

describe('selectAppendableInvoice', () => {
  const open1 = { id: 'a', sent: false, balance: 800, txnDate: '2026-07-15' }
  const open2 = { id: 'b', sent: false, balance: 400, txnDate: '2026-07-20' }
  const sent  = { id: 'c', sent: true,  balance: 1325, txnDate: '2026-07-21' }
  const paid  = { id: 'd', sent: false, balance: 0, txnDate: '2026-07-22' }

  it('picks the most recent open, not-sent invoice', () => {
    expect(selectAppendableInvoice([open1, open2])?.id).toBe('b')
  })
  it('ignores sent invoices (→ create new)', () => {
    expect(selectAppendableInvoice([sent])).toBeNull()
  })
  it('ignores fully-paid (zero balance) invoices', () => {
    expect(selectAppendableInvoice([paid])).toBeNull()
  })
  it('returns null on empty list', () => {
    expect(selectAppendableInvoice([])).toBeNull()
  })
  it('mixed: skips sent+paid, returns the open one', () => {
    expect(selectAppendableInvoice([sent, paid, open1])?.id).toBe('a')
  })
})

describe('duplicate detection', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeStock(' k518991 ')).toBe('K518991')
  })
  it('detects a duplicate stock regardless of case', () => {
    expect(isDuplicateStock(['K518991', 'U442702'], 'k518991')).toBe(true)
  })
  it('no false positive for a new stock', () => {
    expect(isDuplicateStock(['K518991'], 'K999999')).toBe(false)
  })
  it('blank target is never a duplicate', () => {
    expect(isDuplicateStock(['K518991'], null)).toBe(false)
  })
})
