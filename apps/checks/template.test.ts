import { describe, it, expect } from 'vitest'
import { buildCheckTemplate, type CheckFaceDisplay } from './template'
import { buildLayout } from './layout'
import { SETTINGS } from '@/apps/settings/db'

const PHONE = '(979) 696-6640'
const base: CheckFaceDisplay = { companyName: 'Pitt Stop Detail & Auto Sales', companyAddr: '3112 Texas Ave, College Station TX 77845', bankName: 'American Momentum Bank', bankAddr: null }
const micr = { text: 'VOID — NON-NEGOTIABLE', mode: 'placeholder' as const }

describe('check face: company phone', () => {
  it('central business config defaults the check phone to the shop number', () => {
    expect(SETTINGS.check_company_phone.def).toBe(PHONE)
  })

  it('prints the phone on the line directly below the address, matching the address style', () => {
    const layout = buildLayout(null)
    const tpl = buildCheckTemplate({ ...base, companyPhone: PHONE }, layout, micr)
    const addr = tpl.texts.find((t) => t.value === base.companyAddr)!
    const phone = tpl.texts.find((t) => t.value === PHONE)!
    expect(phone).toBeDefined()
    expect(phone.xIn).toBe(addr.xIn)
    expect(phone.sizePt).toBe(addr.sizePt)
    expect(phone.align).toBe(addr.align)
    expect(phone.bold).toBe(addr.bold)
    expect(phone.yIn - addr.yIn).toBeCloseTo(0.14, 5)
    // Stays above the PAY TO THE label so it never crowds the payee area.
    const payTo = tpl.texts.find((t) => t.value === 'PAY TO THE')!
    expect(phone.yIn + phone.sizePt / 72).toBeLessThan(payTo.yIn)
  })

  it('takes the address slot when no address is configured', () => {
    const tpl = buildCheckTemplate({ ...base, companyAddr: null, companyPhone: PHONE }, buildLayout(null), micr)
    expect(tpl.texts.find((t) => t.value === PHONE)!.yIn).toBeCloseTo(0.52, 5)
  })

  it('adds ONLY the phone — every other face element (lines, boxes, MICR, text) is unchanged', () => {
    for (const position of ['top', 'middle', 'bottom'] as const) {
      const layout = buildLayout({ position, offsetX: 0.04, offsetY: -0.03 })
      const without = buildCheckTemplate(base, layout, micr)
      const withPhone = buildCheckTemplate({ ...base, companyPhone: PHONE }, layout, micr)
      expect(withPhone.lines).toEqual(without.lines)
      expect(withPhone.boxes).toEqual(without.boxes)
      expect(withPhone.micr).toEqual(without.micr)
      expect(withPhone.texts.filter((t) => t.value !== PHONE)).toEqual(without.texts)
      expect(withPhone.texts.length).toBe(without.texts.length + 1)
    }
  })

  it('is omitted when cleared in config', () => {
    const tpl = buildCheckTemplate({ ...base, companyPhone: null }, buildLayout(null), micr)
    expect(tpl.texts.some((t) => t.value === PHONE)).toBe(false)
  })
})
