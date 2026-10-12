import { describe, it, expect, afterEach } from 'vitest'
import { assembleCheckTemplate, resolveDeferredMicr, resolveSpecimenMicr } from './template-server'
import { buildLayout, slotOriginY, MICR_CLEAR_BAND_IN } from './layout'
import { buildFields, specimenValues } from './render'
import type { CheckConfig } from './config'

const ROUTING = '021000021' // real, valid ABA checksum
const ACCOUNT = '1234567'

const saved = { r: process.env.MICR_ROUTING, a: process.env.MICR_ACCOUNT }
afterEach(() => {
  for (const [k, v] of [['MICR_ROUTING', saved.r], ['MICR_ACCOUNT', saved.a]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

function cfg(micrEnabled: boolean): CheckConfig {
  return {
    enabled: true, liveEnabled: false, qboRealmId: '', templateMode: 'blank_full', micrEnabled,
    banks: { operating: { key: 'operating', qboAccountId: '31', label: 'Op' }, auto_sales: { key: 'auto_sales', qboAccountId: '48', label: 'AS' } },
    categoryAccounts: {}, layout: buildLayout(null),
    display: { companyName: 'Pitt Stop', companyAddr: null, bankName: 'AMB', bankAddr: null },
  }
}

describe('MICR secret-safety: deferred until claim/print time', () => {
  it('a REAL check enqueue NEVER embeds routing/account — only a non-negotiable placeholder + check number', () => {
    process.env.MICR_ROUTING = ROUTING; process.env.MICR_ACCOUNT = ACCOUNT
    const c = cfg(true) // even fully "ready", enqueue must not bake the line in
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, checkNumber: 20000 })!
    expect(tpl.micr!.mode).toBe('placeholder')
    expect(tpl.micr!.deferCheckNumber).toBe(20000)
    expect(tpl.micr!.value).not.toContain(ROUTING)
    expect(tpl.micr!.value).not.toContain(ACCOUNT)
    expect(tpl.micr!.value).toMatch(/NON-NEGOTIABLE/)
  })

  it('claim-time resolve is a no-op (fail closed) when MICR is not ready', () => {
    delete process.env.MICR_ROUTING; delete process.env.MICR_ACCOUNT
    const c = cfg(false)
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, checkNumber: 20000 })!
    const out = resolveDeferredMicr(tpl, c)!
    expect(out.micr!.mode).toBe('placeholder')
    expect(out.micr!.value).toMatch(/NON-NEGOTIABLE/)
    expect(out.micr!.deferCheckNumber).toBe(20000)
  })

  it('claim-time resolve builds the real E-13B line ONLY when fully ready', () => {
    process.env.MICR_ROUTING = ROUTING; process.env.MICR_ACCOUNT = ACCOUNT
    const c = cfg(true)
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, checkNumber: 20000 })!
    const out = resolveDeferredMicr(tpl, c)!
    expect(out.micr!.mode).toBe('e13b')
    expect(out.micr!.deferCheckNumber).toBeNull()
    // encoded line carries the check number and routing/account (glyph-encoded); it exists only here, in
    // the render request — never persisted to the DB payload.
    const at = (pos: number) => out.micr!.cells!.find((x) => x.pos === pos)?.ch
    expect([50, 49, 48, 47, 46].map(at).join('')).toBe('20000')                        // auxiliary On-Us = check number
    expect([42, 41, 40, 39, 38, 37, 36, 35, 34].map(at).join('')).toBe(ROUTING)        // transit field
    expect(JSON.stringify(tpl)).not.toContain(ROUTING)                                 // the STORED template never has it
  })

  it('a VOID/test page never defers and never touches secrets', () => {
    const c = cfg(true)
    process.env.MICR_ROUTING = ROUTING; process.env.MICR_ACCOUNT = ACCOUNT
    const tpl = assembleCheckTemplate(c, c.layout, { test: true })!
    expect(tpl.micr!.deferCheckNumber ?? null).toBeNull()
    // it prints the all-zero E-13B TEST line (for position/toner checks) — never the real numbers
    expect(tpl.micr!.mode).toBe('e13b')
    const digits = tpl.micr!.cells!.filter((x) => x.pos >= 34 && x.pos <= 42).map((x) => x.ch).join('')
    expect(digits).toBe('000000000')
    expect(JSON.stringify(tpl)).not.toContain(ROUTING)
    expect(JSON.stringify(tpl)).not.toContain(ACCOUNT)
  })
})

describe('bank specimen template', () => {
  it('stores no bank numbers, is marked VOID, and resolves to the real line even with the MICR switch off', () => {
    process.env.MICR_ROUTING = ROUTING; process.env.MICR_ACCOUNT = ACCOUNT
    const c = cfg(false)
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, specimen: true })!
    expect(JSON.stringify(tpl)).not.toContain(ROUTING); expect(JSON.stringify(tpl)).not.toContain(ACCOUNT)
    expect(tpl.micr).toMatchObject({ mode: 'placeholder', deferSpecimen: true })
    expect(tpl.texts.filter((t) => /\bVOID\b/.test(t.value)).length).toBe(2)
    expect(resolveDeferredMicr(tpl, c)).toBe(tpl)                       // never treated as a real check
    const resolved = resolveSpecimenMicr(tpl)!
    expect(resolved.micr).toMatchObject({ mode: 'e13b', deferSpecimen: null })
    expect(resolved.micr!.cells!.filter((x) => x.pos >= 46 && x.ch !== 'C').map((x) => x.ch).join('')).toBe('000000')
  })

  it('stays unresolved (so the caller refuses) when the bank numbers are not valid', () => {
    process.env.MICR_ROUTING = ROUTING; process.env.MICR_ACCOUNT = ACCOUNT
    const c = cfg(true)
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, specimen: true })!
    delete process.env.MICR_ACCOUNT
    expect(resolveSpecimenMicr(tpl)).toBe(tpl)
  })

  it('puts nothing but the MICR line in the bottom 5/8" clear band', () => {
    const c = cfg(false)
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, specimen: true })!
    const bandTop = slotOriginY(c.layout.position) + c.layout.offsetY + c.layout.sectionHeightIn - MICR_CLEAR_BAND_IN
    for (const t of tpl.texts) expect(t.yIn + t.sizePt / 72, t.value).toBeLessThanOrEqual(bandTop)
    for (const l of tpl.lines) expect(Math.max(l.y1In, l.y2In)).toBeLessThanOrEqual(bandTop)
    for (const b of tpl.boxes) expect(b.yIn + b.hIn).toBeLessThanOrEqual(bandTop)
    for (const f of buildFields(specimenValues(), c.layout)) expect(f.yIn + f.sizePt / 72, f.key).toBeLessThanOrEqual(bandTop)
    expect(tpl.micr!.yIn).toBeGreaterThan(bandTop)                      // the MICR baseline itself is inside the band
  })

  it('a normal VOID test page and a real check are unaffected', () => {
    const c = cfg(false)
    expect(assembleCheckTemplate(c, c.layout, { test: true })!.texts.some((t) => /SPECIMEN/.test(t.value))).toBe(false)
    expect(assembleCheckTemplate(c, c.layout, { test: false, checkNumber: 10356 })!.micr).toMatchObject({ deferCheckNumber: 10356, deferSpecimen: null })
  })
})
