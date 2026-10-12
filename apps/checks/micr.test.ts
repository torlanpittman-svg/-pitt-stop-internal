import { describe, it, expect, afterEach } from 'vitest'
import { vi } from 'vitest'
import { isValidRouting, isValidAccount, maskTail, micrReadiness, buildMicrCells, layoutMicrCells, testMicrCells, MICR_POS, specimenReadiness, buildSpecimenMicrCells } from './micr'
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
    expect([51, 50, 49, 48, 47, 46].map((p) => at(cells, p)).join('')).toBe('001055') // check number, six digits
    expect(at(cells, 52)).toBe('C')
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
  it('a real line writes the check number as six digits with a leading zero (10356 → 010356)', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '1234567'
    const cells = buildMicrCells(10356)
    expect([51, 50, 49, 48, 47, 46].map((p) => at(cells, p)).join('')).toBe('010356')
    expect(at(cells, 45)).toBe('C'); expect(at(cells, 52)).toBe('C')
    expect(at(cells, 53)).toBeUndefined()
    // padding only ever grows the field to the LEFT: everything from position 46 rightwards is unchanged
    const unpadded = layoutMicrCells({ routing: '021000021', account: '1234567', checkNumber: 10356 })
    const rightOf = (cs: typeof cells) => cs.filter((c) => c.pos <= 46)
    expect(rightOf(cells)).toEqual(rightOf(unpadded))
  })
  it('six digits pass through unchanged, a leading zero typed in is kept, and seven digits are not cut', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '1234567'
    const num = (n: number | string) => { const cs = buildMicrCells(n); return cs.filter((c) => c.pos >= 46 && c.ch !== 'C').sort((a, b) => b.pos - a.pos).map((c) => c.ch).join('') }
    expect(num(123456)).toBe('123456')
    expect(num('010356')).toBe('010356')
    expect(num(1)).toBe('000001')
    expect(num(1234567)).toBe('1234567')
  })
  it('keeps every leading zero of the account number', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '0001234567'
    const cells = buildMicrCells(10356)
    expect([24, 23, 22, 21, 20, 19, 18, 17, 16, 15].map((p) => at(cells, p)).join('')).toBe('0001234567')
    expect(at(cells, 25)).toBeUndefined()
  })
  it('a bank specimen carries the real routing/account with check number 000000 — and does not need the MICR switch', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '0001234567'
    expect(micrReadiness(false).ready).toBe(false)                    // negotiable checks stay blocked
    expect(specimenReadiness()).toMatchObject({ secretsPresent: true, routingValid: true, accountValid: true, ready: true })
    const cells = buildSpecimenMicrCells()
    expect(cells.filter((c) => c.pos <= 44)).toEqual(buildMicrCells(10356).filter((c) => c.pos <= 44)) // same line as a real check
    expect([51, 50, 49, 48, 47, 46].map((p) => at(cells, p)).join('')).toBe('000000')
  })
  it('a specimen is refused without valid bank numbers', () => {
    delete process.env.MICR_ROUTING; delete process.env.MICR_ACCOUNT
    expect(specimenReadiness().ready).toBe(false)
    expect(() => buildSpecimenMicrCells()).toThrow()
    process.env.MICR_ROUTING = '021000022'; process.env.MICR_ACCOUNT = '1234567'   // bad checksum
    expect(specimenReadiness().ready).toBe(false)
    expect(() => buildSpecimenMicrCells()).toThrow()
  })
  it('the approved VOID test line is unchanged by the padding (five zeros, symbols at 45 and 51)', () => {
    const cells = testMicrCells()
    expect([50, 49, 48, 47, 46].map((p) => at(cells, p)).join('')).toBe('00000')
    expect(at(cells, 45)).toBe('C'); expect(at(cells, 51)).toBe('C'); expect(at(cells, 52)).toBeUndefined()
  })
  it('the VOID test line carries no bank data (all-zero routing)', () => {
    const cells = testMicrCells()
    expect([42, 41, 40, 39, 38, 37, 36, 35, 34].map((p) => at(cells, p)).join('')).toBe('000000000')
    expect([24, 23, 22, 21, 20, 19, 18, 17, 16, 15].map((p) => at(cells, p)).join('')).toBe('0123456789') // every digit glyph
  })
})
