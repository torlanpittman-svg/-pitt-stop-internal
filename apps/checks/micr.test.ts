import { describe, it, expect, afterEach } from 'vitest'
import { isValidRouting, isValidAccount, maskTail, micrReadiness, buildMicrLine, E13B } from './micr'

const saved = { r: process.env.MICR_ROUTING, a: process.env.MICR_ACCOUNT, f: process.env.MICR_FONT_PATH }
afterEach(() => {
  process.env.MICR_ROUTING = saved.r; process.env.MICR_ACCOUNT = saved.a; process.env.MICR_FONT_PATH = saved.f
  if (saved.r === undefined) delete process.env.MICR_ROUTING
  if (saved.a === undefined) delete process.env.MICR_ACCOUNT
  if (saved.f === undefined) delete process.env.MICR_FONT_PATH
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
    delete process.env.MICR_ROUTING; delete process.env.MICR_ACCOUNT; delete process.env.MICR_FONT_PATH
    const r = micrReadiness(true)
    expect(r.ready).toBe(false)
    expect(r.secretsPresent).toBe(false)
    expect(r.routingMask).toBe('')
  })
  it('not ready without the font even with valid secrets + enabled', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '1234567'; delete process.env.MICR_FONT_PATH
    const r = micrReadiness(true)
    expect(r.secretsPresent && r.routingValid && r.accountValid).toBe(true)
    expect(r.fontInstalled).toBe(false)
    expect(r.ready).toBe(false)
    expect(r.routingMask).toBe('••••0021')  // never the full number
  })
  it('ready only when enabled + valid secrets + font', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '1234567'; process.env.MICR_FONT_PATH = '/fonts/e13b.ttf'
    expect(micrReadiness(true).ready).toBe(true)
    expect(micrReadiness(false).ready).toBe(false) // toggle off ⇒ not ready
  })
})

describe('buildMicrLine — standard business-check field order', () => {
  it('throws when secrets missing (fail closed)', () => {
    delete process.env.MICR_ROUTING; delete process.env.MICR_ACCOUNT
    expect(() => buildMicrLine(1234)).toThrow()
  })
  it('emits ⑈check#⑈ ⑆routing⑆ account⑈ with matching check number', () => {
    process.env.MICR_ROUTING = '021000021'; process.env.MICR_ACCOUNT = '1234567'
    const { unicode, encoded } = buildMicrLine(1055)
    expect(unicode).toBe(`${E13B.onUs.unicode}1055${E13B.onUs.unicode}  ${E13B.transit.unicode}021000021${E13B.transit.unicode}  1234567${E13B.onUs.unicode}`)
    expect(encoded).toBe('C1055C  A021000021A  1234567C')  // font-glyph encoding
  })
})
