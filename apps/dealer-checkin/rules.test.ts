import { describe, it, expect } from 'vitest'
import {
  extractStockPrefix,
  matchDealershipByStock,
  formatLineDescription,
  decidePricing,
  selectAppendableInvoice,
  isDuplicateStock,
  normalizeStock,
  clampText,
  normalizeYear,
  stripInvalidPgChars,
  sanitizeRawOcr,
  RAW_OCR_MAX_BYTES,
  STANDARD_RATE,
  NEW_STERLING_AUTO_RATE,
} from './rules'

const NUL = String.fromCharCode(0)

describe('stripInvalidPgChars', () => {
  it('removes NUL and other C0 control chars but keeps tab/newline/return', () => {
    const out = stripInvalidPgChars(`a${NUL}bc\td\ne\rf`)
    expect(out).toBe('abc\td\ne\rf')
    expect(out.includes(NUL)).toBe(false)
  })
  it('keeps valid (paired) Unicode/emoji, drops lone surrogates', () => {
    expect(stripInvalidPgChars('car 🚗 ok')).toBe('car 🚗 ok')
    expect(stripInvalidPgChars('x\uD800y')).toBe('xy') // lone high surrogate removed
  })
})

describe('sanitizeRawOcr (raw_ocr audit payload)', () => {
  // Mirrors what extractVehicleData returns, incl. the heavy debug artifacts.
  const ocr = {
    stockNumber: 'TE291607', year: '2026', make: 'Kia', model: 'K4', modelName: 'K4 LXS',
    color: 'Gray', confidence: { stockNumber: 0.94, color: 0.8 },
    providerName: 'openai', promptVersion: 'v4',
    rawResponse: { reasoning: `clear tag${NUL} readable` }, // contains the 22P05 trigger
    stockDebugData: `detector-internals${NUL}`,
    stockCropMimeType: 'image/png',
    stockCropBase64: 'QUJD'.repeat(5000),
    stockDebugOverlayBase64: 'A'.repeat(2_200_000), // 2.2 MB debug overlay
  }

  it('reproduces + neutralizes the SQLSTATE 22P05 trigger (no \\u0000 survives)', () => {
    // A literal NUL in a jsonb string is what Postgres rejects with 22P05
    // ("unsupported Unicode escape sequence"). The sanitized payload must be free of it.
    const out = sanitizeRawOcr(ocr)!
    const json = JSON.stringify(out)
    expect(json.includes(NUL)).toBe(false)
    expect(json.includes('\\u0000')).toBe(false)
  })

  it('excludes the 2.2 MB overlay and all base64/binary debug artifacts', () => {
    const out = sanitizeRawOcr(ocr)!
    expect(out).not.toHaveProperty('stockDebugOverlayBase64')
    expect(out).not.toHaveProperty('stockCropBase64')
    expect(out).not.toHaveProperty('stockCropMimeType')
    expect(out).not.toHaveProperty('stockDebugData')
    // and the whole row stays tiny, never multi-megabyte
    expect(JSON.stringify(out).length).toBeLessThan(RAW_OCR_MAX_BYTES)
  })

  it('keeps the meaningful OCR metadata for audit/debugging', () => {
    const out = sanitizeRawOcr(ocr)!
    expect(out).toMatchObject({
      stockNumber: 'TE291607', year: '2026', make: 'Kia', model: 'K4', modelName: 'K4 LXS',
      color: 'Gray', providerName: 'openai', promptVersion: 'v4',
      confidence: { stockNumber: 0.94, color: 0.8 },
    })
    expect(typeof out.rawResponse).toBe('string')
    expect(String(out.rawResponse)).toContain('clear tag') // sanitized, still present
  })

  it('hard-caps an oversized raw model response', () => {
    const out = sanitizeRawOcr({ stockNumber: 'K1', rawResponse: 'x'.repeat(50_000) })!
    expect(String(out.rawResponse)).toContain('…[truncated]')
    expect(JSON.stringify(out).length).toBeLessThan(RAW_OCR_MAX_BYTES)
  })

  it('returns null for empty/non-object input', () => {
    expect(sanitizeRawOcr(null)).toBeNull()
    expect(sanitizeRawOcr('nope')).toBeNull()
  })
})

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

describe('matchDealershipByStock (dealer resolution incl. Purdy "AP")', () => {
  // Mirrors the real prod dealers + the new Purdy Mazda.
  const dealers = [
    { id: 's', name: 'Sterling Auto Group', stockPrefix: 'S' },
    { id: 't', name: 'Sterling Auto Group', stockPrefix: 'T' },
    { id: 'k', name: 'Sterling Kia', stockPrefix: 'K' },
    { id: 'u', name: 'Sterling Subaru', stockPrefix: 'U' },
    { id: 'ap', name: 'Purdy Mazda', stockPrefix: 'AP' },
  ]
  const who = (stock: string) => matchDealershipByStock(stock, dealers)?.name ?? null

  it('AP resolves only to Purdy Mazda', () => {
    expect(who('AP12345')).toBe('Purdy Mazda')
    expect(who('ap00042')).toBe('Purdy Mazda')   // case-insensitive
    expect(who(' AP-7 ')).toBe('Purdy Mazda')     // trims
  })
  it('existing single-letter dealers resolve exactly as before', () => {
    expect(who('S515324')).toBe('Sterling Auto Group')
    expect(who('TJ285137')).toBe('Sterling Auto Group')
    expect(who('K518991')).toBe('Sterling Kia')
    expect(who('up003483')).toBe('Sterling Subaru')
  })
  it('A-but-not-AP stocks do NOT match Purdy (no over-capture)', () => {
    expect(who('AT1234')).toBeNull()   // real OCR noise seen in prod — must not hit Purdy
    expect(who('A9999')).toBeNull()
  })
  it('longest prefix wins when prefixes overlap', () => {
    const overlap = [{ id: 'a', name: 'A Dealer', stockPrefix: 'A' }, { id: 'ap', name: 'Purdy Mazda', stockPrefix: 'AP' }]
    expect(matchDealershipByStock('AP123', overlap)?.name).toBe('Purdy Mazda')
    expect(matchDealershipByStock('AB123', overlap)?.name).toBe('A Dealer')
  })
  it('no stock / no match → null', () => {
    expect(who('')).toBeNull()
    expect(matchDealershipByStock(null, dealers)).toBeNull()
    expect(who('W71')).toBeNull()
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
