import { describe, it, expect, afterEach } from 'vitest'
import { micrPlacement, micrGeom, buildLayout, DEFAULT_MICR_GEOM, PAGE_WIDTH_IN, CHECK_SECTION_HEIGHT_IN } from './layout'
import { renderCheckPdf, loadMicrFont } from './pdf'
import type { CheckPrintPayload } from './render'
import type { CheckTemplate } from './template'

const saved = { p: process.env.MICR_FONT_PATH, b: process.env.MICR_FONT_B64 }
afterEach(() => {
  for (const [k, v] of [['MICR_FONT_PATH', saved.p], ['MICR_FONT_B64', saved.b]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

describe('standards-based MICR placement (ANSI X9.100-160)', () => {
  it('baseline = 3/16" above the bottom edge (perforation); right-anchored inset for the blank Amount field', () => {
    const pl = micrPlacement(CHECK_SECTION_HEIGHT_IN, PAGE_WIDTH_IN)
    expect(pl.baselineYIn).toBeCloseTo(3.5 - 0.1875, 5)          // 3.3125" from the check top
    expect(3.5 - pl.baselineYIn).toBeCloseTo(0.1875, 5)          // i.e., 3/16" above the perforation
    expect(pl.rightAnchorXIn).toBeCloseTo(8.5 - 0.25 - 1.5, 5)   // right margin + 12-position Amount field
    expect(pl.pitchIn).toBeCloseTo(0.125, 5)                     // 8 CPI
    expect(pl.sizePt).toBe(10)                                   // E-13B @ 10pt
  })

  it('MICR-only calibration override does not touch non-MICR geometry', () => {
    const layout = buildLayout({ micr: { baselineFromBottomIn: 0.25 } as Partial<typeof DEFAULT_MICR_GEOM> })
    expect(layout.micr.baselineFromBottomIn).toBeCloseTo(0.25, 5) // overridden
    expect(layout.micr.pitchIn).toBeCloseTo(0.125, 5)             // untouched default
    expect(layout.offsetX).toBe(0); expect(layout.offsetY).toBe(0)
    expect(layout.sectionHeightIn).toBe(3.5)
    expect(layout.perField.payee.yIn).toBe(1.02)                 // locked field unchanged
    // negative/garbage values fall back to the standard default
    expect(micrGeom({ baselineFromBottomIn: -1 as unknown as number }).baselineFromBottomIn).toBe(DEFAULT_MICR_GEOM.baselineFromBottomIn)
  })
})

function payloadWithMicr(micr: NonNullable<CheckTemplate['micr']>): CheckPrintPayload {
  return { pageWidthIn: 8.5, pageHeightIn: 11, fields: [], template: { texts: [], lines: [], boxes: [], micr } }
}
const e13bLine = 'C20000C  A021000021A  1234567C' // representative encoded line w/ routing 021000021 + acct 1234567

describe('MICR rendering — fail-closed font embedding', () => {
  it('a REAL (e13b) line with NO font installed NEVER prints routing/account — fails closed to a placeholder', () => {
    delete process.env.MICR_FONT_PATH; delete process.env.MICR_FONT_B64
    expect(loadMicrFont()).toBeNull()
    const pdf = renderCheckPdf(payloadWithMicr({ value: e13bLine, xIn: 6.75, yIn: 3.3125, sizePt: 10, align: 'right', mode: 'e13b', deferCheckNumber: null, pitchIn: 0.125 })).toString('latin1')
    expect(pdf).not.toContain('021000021') // routing never printed
    expect(pdf).not.toContain('1234567')   // account never printed
    expect(pdf).not.toContain('/F3')       // no MICR font embedded
    expect(pdf).toContain('(N)')           // placeholder chars are drawn (fixed-pitch, per char)
  })

  it('with the licensed font present, the MICR font is embedded (/F3 + FontFile2) and used', () => {
    process.env.MICR_FONT_B64 = Buffer.from('dummy-ttf-bytes').toString('base64')
    const pdf = renderCheckPdf(payloadWithMicr({ value: e13bLine, xIn: 6.75, yIn: 3.3125, sizePt: 10, align: 'right', mode: 'e13b', deferCheckNumber: null, pitchIn: 0.125 })).toString('latin1')
    expect(pdf).toContain('/F3')
    expect(pdf).toContain('/FontFile2')
    expect(pdf).toContain('/MICRE13B')
    expect(pdf).toContain('/Subtype /TrueType')
  })

  it('a placeholder MICR line renders without the MICR font (non-negotiable)', () => {
    const pdf = renderCheckPdf(payloadWithMicr({ value: 'NON-NEGOTIABLE TEST', xIn: 6.75, yIn: 3.3125, sizePt: 10, align: 'right', mode: 'placeholder', deferCheckNumber: null, pitchIn: 0.125 })).toString('latin1')
    expect(pdf).not.toContain('/F3')
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    expect(pdf).toContain('%%EOF')
  })
})
