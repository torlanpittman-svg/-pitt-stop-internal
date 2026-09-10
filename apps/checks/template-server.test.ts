import { describe, it, expect, afterEach } from 'vitest'
import { assembleCheckTemplate, resolveDeferredMicr } from './template-server'
import { buildLayout } from './layout'
import type { CheckConfig } from './config'

const ROUTING = '021000021' // real, valid ABA checksum
const ACCOUNT = '1234567'

const saved = { r: process.env.MICR_ROUTING, a: process.env.MICR_ACCOUNT, f: process.env.MICR_FONT_PATH }
afterEach(() => {
  for (const [k, v] of [['MICR_ROUTING', saved.r], ['MICR_ACCOUNT', saved.a], ['MICR_FONT_PATH', saved.f]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

function cfg(micrEnabled: boolean): CheckConfig {
  return {
    enabled: true, templateMode: 'blank_full', micrEnabled,
    banks: { operating: { key: 'operating', qboAccountId: '31', label: 'Op' }, auto_sales: { key: 'auto_sales', qboAccountId: '48', label: 'AS' } },
    categoryAccounts: {}, layout: buildLayout(null),
    display: { companyName: 'Pitt Stop', companyAddr: null, bankName: 'AMB', bankAddr: null },
  }
}

describe('MICR secret-safety: deferred until claim/print time', () => {
  it('a REAL check enqueue NEVER embeds routing/account — only a non-negotiable placeholder + check number', () => {
    process.env.MICR_ROUTING = ROUTING; process.env.MICR_ACCOUNT = ACCOUNT; process.env.MICR_FONT_PATH = '/x/e13b.ttf'
    const c = cfg(true) // even fully "ready", enqueue must not bake the line in
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, checkNumber: 20000 })!
    expect(tpl.micr!.mode).toBe('placeholder')
    expect(tpl.micr!.deferCheckNumber).toBe(20000)
    expect(tpl.micr!.value).not.toContain(ROUTING)
    expect(tpl.micr!.value).not.toContain(ACCOUNT)
    expect(tpl.micr!.value).toMatch(/NON-NEGOTIABLE/)
  })

  it('claim-time resolve is a no-op (fail closed) when MICR is not ready', () => {
    delete process.env.MICR_ROUTING; delete process.env.MICR_ACCOUNT; delete process.env.MICR_FONT_PATH
    const c = cfg(false)
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, checkNumber: 20000 })!
    const out = resolveDeferredMicr(tpl, c)!
    expect(out.micr!.mode).toBe('placeholder')
    expect(out.micr!.value).toMatch(/NON-NEGOTIABLE/)
    expect(out.micr!.deferCheckNumber).toBe(20000)
  })

  it('claim-time resolve builds the real E-13B line ONLY when fully ready', () => {
    process.env.MICR_ROUTING = ROUTING; process.env.MICR_ACCOUNT = ACCOUNT; process.env.MICR_FONT_PATH = '/x/e13b.ttf'
    const c = cfg(true)
    const tpl = assembleCheckTemplate(c, c.layout, { test: false, checkNumber: 20000 })!
    const out = resolveDeferredMicr(tpl, c)!
    expect(out.micr!.mode).toBe('e13b')
    expect(out.micr!.deferCheckNumber).toBeNull()
    // encoded line carries the check number and routing/account (glyph-encoded); it exists only here, in
    // the render request — never persisted to the DB payload.
    expect(out.micr!.value).toContain('20000')
    expect(out.micr!.value).toContain(ROUTING)
  })

  it('a VOID/test page never defers and never touches secrets', () => {
    const c = cfg(true)
    const tpl = assembleCheckTemplate(c, c.layout, { test: true })!
    expect(tpl.micr!.mode).toBe('placeholder')
    expect(tpl.micr!.deferCheckNumber ?? null).toBeNull()
  })
})
