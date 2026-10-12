import { describe, it, expect, afterEach } from 'vitest'
import { vi } from 'vitest'
import { isValidRouting, isValidAccount, maskTail, micrReadiness, buildMicrCells, layoutMicrCells, testMicrCells, MICR_POS } from './micr'
import { resetMicrFontCache } from './micr-font'

const saved = { r: process.env.MICR_ROUTING, a: process.env.MICR_ACCOUNT }
afterEach(() => {
  process.env.MICR_ROUTING = saved.r; process.env.MICR_ACCOUNT = saved.a;   if (saved.r === undefined) delete process.env.MICR_ROUTING
  if (saved.a === undefined) delete process.env.MICR_ACCOUNT
})

describe('routing/account validation', () => {
  it('validates ABA checksum (021000021 is a real valid routing)', () => {
    expect(isValidRouting('021000021')).toBe(true)
    expect(isValidRouting('021000022')).toBe(false)  // bad check digit
    expect(isValidRouting('12345')).toBe(false)       // wrong length
  })
  it('validates account length 4–17', () => {
    expect(isValidAccount('1234')).toBe(true)
    expect(isValidAccount('123')).toBe(false)
    expect(isValidAccount('1'.repeat(18))).toBe(false)
  })
  it('masks to last 4 only', () => {
    expect(maskTail('000123456789')).toBe('••••6789')
  })
})

describe('micrReadiness — fail closed, masks only (never leaks the number)', () => {
  it('not ready when secrets absent', () => {
    delete process.env.MICR_ROUTING; delete process.env.MICR_ACCOUNT
    const r = micrReadiness(true)
    expect(r.ready).toBe(false)
    expect(r.secretsPresent).toBe(false)
    expect(r.routingMask).toBe('')
  })
  it('not ready when the E-13B font cannot be loaded, even with valid secrets + enabled', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '1234567'
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-dir'); resetMicrFontCache()
    try {
      const r = micrReadiness(true)
      expect(r.secretsPresent && r.routingValid && r.accountValid).toBe(true)
      expect(r.fontInstalled).toBe(false)
      expect(r.ready).toBe(false)
      expect(r.routingMask).toBe('••••0021')  // never the full number
    } finally { cwd.mockRestore(); resetMicrFontCache() }
  })
  it('ready only when enabled + valid secrets + the bundled font', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '1234567'
    expect(micrReadiness(true).fontInstalled).toBe(true)
    expect(micrReadiness(true).ready).toBe(true)
    expect(micrReadiness(false).ready).toBe(false) // toggle off ⇒ not ready
  })
})

const at = (cells: { pos: number; ch: string }[], pos: number) => cells.find((c) => c.pos === pos)?.ch

describe('MICR line — fixed ANSI positions (fields never float)', () => {
  it('throws when secrets missing (fail closed)', () => {
    delete process.env.MICR_ROUTING; delete process.env.MICR_ACCOUNT
    expect(() => buildMicrCells(1234)).toThrow()
  })
  it('places On-Us at 14, transit at 33–43, auxiliary On-Us from 45, with 13/32/44 blank', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '1234567'
    const cells = buildMicrCells(1055)
    expect(at(cells, 14)).toBe('C')                                   // closing On-Us symbol
    expect([15, 16, 17, 18, 19, 20, 21].map((p) => at(cells, p)).join('')).toBe('7654321') // account, right→left
    expect(at(cells, 33)).toBe('A'); expect(at(cells, 43)).toBe('A')  // transit symbols
    expect([42, 41, 40, 39, 38, 37, 36, 35, 34].map((p) => at(cells, p)).join('')).toBe('021000021')
    expect(at(cells, 45)).toBe('C')
    expect([49, 48, 47, 46].map((p) => at(cells, p)).join('')).toBe('1055') // printed check number
    expect(at(cells, 50)).toBe('C')
    for (const blank of [13, 32, 44]) expect(at(cells, blank)).toBeUndefined()
    expect(Math.min(...cells.map((c) => c.pos))).toBe(MICR_POS.onUsSymbol) // nothing in the Amount field (1–12)
  })
  it('the transit field does not move when the account length changes', () => {
    const short = layoutMicrCells({ routing: '021000021', account: '1234', checkNumber: 20000 })
    const long = layoutMicrCells({ routing: '021000021', account: '12345678901234567', checkNumber: 20000 })
    const transit = (cs: typeof short) => cs.filter((c) => c.pos >= 33 && c.pos <= 43)
    expect(transit(short)).toEqual(transit(long))
    expect(at(long, 31)).toBe('1') // a 17-digit account exactly fills 15–31
  })
  it('refuses a field that cannot fit its positions rather than squeezing it', () => {
    expect(() => layoutMicrCells({ routing: '021000021', account: '123456789012345678', checkNumber: 1 })).toThrow(/On-Us/)
    expect(() => layoutMicrCells({ routing: '02100002', account: '1234', checkNumber: 1 })).toThrow(/9 digits/)
    expect(() => layoutMicrCells({ routing: '021000021', account: '1234', checkNumber: '12345678901234567890' })).toThrow(/Auxiliary/)
  })
  it('the VOID test line carries no bank data (all-zero routing)', () => {
    const cells = testMicrCells()
    expect([42, 41, 40, 39, 38, 37, 36, 35, 34].map((p) => at(cells, p)).join('')).toBe('000000000')
    expect([24, 23, 22, 21, 20, 19, 18, 17, 16, 15].map((p) => at(cells, p)).join('')).toBe('0123456789') // every digit glyph
  })
})
