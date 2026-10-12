import { describe, it, expect } from 'vitest'
import { micrPlacement, micrGeom, buildLayout, DEFAULT_MICR_GEOM, PAGE_WIDTH_IN, CHECK_SECTION_HEIGHT_IN } from './layout'
import { vi } from 'vitest'
import { renderCheckPdf } from './pdf'
import { loadMicrFont, resetMicrFontCache, MICR_FONT } from './micr-font'
import { layoutMicrCells } from './micr'
import { micrPositionRightX } from './layout'
import type { CheckPrintPayload } from './render'
import type { CheckTemplate } from './template'


describe('standards-based MICR placement (ANSI X9.100-160)', () => {
  it('baseline = 3/16" above the bottom edge (perforation); anchored on the right edge of position 14', () => {
    const pl = micrPlacement(CHECK_SECTION_HEIGHT_IN, PAGE_WIDTH_IN)
    expect(pl.baselineYIn).toBeCloseTo(3.5 - 0.1875, 5)          // 3.3125" from the check top
    expect(3.5 - pl.baselineYIn).toBeCloseTo(0.1875, 5)          // i.e., 3/16" above the perforation
    expect(pl.rightAnchorXIn).toBeCloseTo(8.5 - 0.3125 - 13 * 0.125, 5) // position 1 at 5/16", then positions 1–13 clear
    expect(8.5 - micrPositionRightX(1, pl.rightAnchorXIn, pl.pitchIn)).toBeCloseTo(0.3125, 5)   // position 1: 5/16" from the right edge
    expect(8.5 - micrPositionRightX(33, pl.rightAnchorXIn, pl.pitchIn)).toBeCloseTo(0.3125 + 32 * 0.125, 5)
    expect(pl.pitchIn).toBeCloseTo(0.125, 5)                     // 8 CPI
    expect(pl.sizePt).toBe(12)                                   // GnuMICR E-13B design size
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
const cells = layoutMicrCells({ routing: '021000021', account: '1234567', checkNumber: 20000 })
const e13b = (): NonNullable<CheckTemplate['micr']> => ({ value: '', cells, xIn: 6.5625, yIn: 3.3125, sizePt: 12, align: 'right', mode: 'e13b', deferCheckNumber: null, pitchIn: 0.125 })
/** x (inches) of every /F3 glyph origin in the content stream, with its character. */
const glyphs = (pdf: string) => [...pdf.matchAll(/BT \/F3 12 Tf ([\d.]+) ([\d.]+) Td \((.)\) Tj ET/g)].map((m) => ({ xIn: Number(m[1]) / 72, yPt: Number(m[2]), ch: m[3] }))

describe('MICR rendering — embedded E-13B font on the position grid', () => {
  it('a REAL (e13b) line with NO usable font NEVER prints routing/account — fails closed to a notice', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-dir'); resetMicrFontCache()
    try {
      expect(loadMicrFont()).toBeNull()
      const pdf = renderCheckPdf(payloadWithMicr(e13b())).toString('latin1')
      expect(pdf).not.toContain('/F3')           // no MICR font, no MICR glyphs
      expect(pdf).not.toContain('/FontFile')
      expect(glyphs(pdf)).toHaveLength(0)
      expect(pdf).toContain('(N)')               // the NON-NEGOTIABLE notice is drawn instead
      // no run of bank digits anywhere in the page content
      const drawn = [...pdf.matchAll(/Td \((.)\) Tj/g)].map((m) => m[1]).join('')
      expect(drawn).not.toMatch(/\d/)
    } finally { cwd.mockRestore(); resetMicrFontCache() }
  })

  it('embeds the Type 1 font (FontFile, built-in encoding) and uses it for every MICR character', () => {
    const pdf = renderCheckPdf(payloadWithMicr(e13b())).toString('latin1')
    expect(pdf).toContain('/BaseFont /GnuMICR')
    expect(pdf).toContain('/Subtype /Type1 /BaseFont /GnuMICR')
    expect(pdf).toMatch(/\/FontFile 9 0 R/)
    expect(pdf).toMatch(/\/Length1 1458 \/Length2 3781 \/Length3 544/)
    expect(pdf.match(/7 0 obj\n(<<[^\n]*>>)\nendobj/)![1]).not.toContain('/Encoding') // font's own encoding selects the glyphs
    expect(glyphs(pdf)).toHaveLength(cells.length)
  })

  it('puts each character\'s RIGHT edge on the right edge of its ANSI position (8 per inch, 5/16" reference)', () => {
    const pdf = renderCheckPdf(payloadWithMicr(e13b())).toString('latin1')
    const glyphRightIn = (MICR_FONT.glyphRight / 1000) * 12 / 72
    const drawn = glyphs(pdf)
    cells.forEach((c, i) => {
      const fromRightEdge = 8.5 - (drawn[i].xIn + glyphRightIn)
      expect(drawn[i].ch).toBe(c.ch)
      expect(fromRightEdge).toBeCloseTo(0.3125 + (c.pos - 1) * 0.125, 3)
      expect(drawn[i].yPt).toBeCloseTo((11 - 3.3125) * 72, 2)   // baseline, 3/16" above the perforation
    })
    // rightmost printed character (On-Us symbol, position 14) leaves the whole Amount field clear
    expect(8.5 - (Math.max(...drawn.map((d) => d.xIn)) + glyphRightIn)).toBeCloseTo(1.9375, 3)
  })

  it('refuses to draw cells the font cannot render or that fall in the Amount field', () => {
    for (const bad of [[{ pos: 14, ch: 'X' }], [{ pos: 5, ch: '1' }], []]) {
      const pdf = renderCheckPdf(payloadWithMicr({ ...e13b(), cells: bad })).toString('latin1')
      expect(pdf).not.toContain('/F3')
    }
  })

  it('a placeholder MICR line renders without the MICR font (non-negotiable)', () => {
    const pdf = renderCheckPdf(payloadWithMicr({ value: 'NON-NEGOTIABLE TEST', xIn: 6.5625, yIn: 3.3125, sizePt: 12, align: 'right', mode: 'placeholder', deferCheckNumber: null, pitchIn: 0.125 })).toString('latin1')
    expect(pdf).not.toContain('/F3')
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    expect(pdf).toContain('%%EOF')
  })

  it('the calibration gauge is drawn only when asked for', () => {
    const p = payloadWithMicr(e13b())
    expect(renderCheckPdf(p).toString('latin1')).not.toContain('0.2 0.5 0.9 RG')
    expect(renderCheckPdf(p, { micrGauge: { bottomYIn: 3.5 } }).toString('latin1')).toContain('0.2 0.5 0.9 RG')
  })
})
