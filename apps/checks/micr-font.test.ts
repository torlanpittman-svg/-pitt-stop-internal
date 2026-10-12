import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MICR_FONT, MICR_FONT_CHARS, loadMicrFont, parsePfb } from './micr-font'

const dir = join(process.cwd(), 'apps', 'checks', 'fonts', 'gnumicr')
/** Parse the font's own AFM (shipped by the author) → per-character metrics. */
const afm = Object.fromEntries(
  readFileSync(join(dir, 'GnuMICR.afm'), 'utf8').split('\n')
    .map((l) => l.match(/^C (-?\d+) ; WX (\d+) ; N (\S+) ; B (-?\d+) (-?\d+) (-?\d+) (-?\d+)/))
    .filter((m): m is RegExpMatchArray => !!m && Number(m[1]) > 32 && Number(m[1]) < 128)
    .map((m) => [String.fromCharCode(Number(m[1])), { wx: +m[2], xMin: +m[4], yMin: +m[5], xMax: +m[6], yMax: +m[7] }]),
)
const IN_PER_UNIT = MICR_FONT.designSizePt / 72 / MICR_FONT.unitsPerEm

describe('bundled E-13B font (GnuMICR 0.30) — the file is what the code assumes', () => {
  it('is the pinned, unmodified font file and ships with its license + source', () => {
    expect(createHash('sha256').update(readFileSync(join(dir, 'GnuMICR.pfb'))).digest('hex')).toBe(MICR_FONT.sha256)
    for (const f of ['COPYING', 'README', 'AUTHORS', 'GnuMICR.raw', 'NOTICE.md']) expect(readFileSync(join(dir, f)).length).toBeGreaterThan(0)
    expect(readFileSync(join(dir, 'COPYING'), 'utf8')).toContain('GNU GENERAL PUBLIC LICENSE')
  })

  it('loads as a 3-section Type 1 program', () => {
    const f = loadMicrFont()!
    expect(f).not.toBeNull()
    expect([f.clear.length, f.encrypted.length, f.trailer.length]).toEqual([1458, 3781, 544])
    expect(f.clear.toString('latin1')).toContain('/FontName /GnuMICR')
    expect(() => parsePfb(Buffer.from('not a font'))).toThrow()
  })

  it('defines exactly the 10 digits and 4 symbols we print, at the codes we use', () => {
    expect(Object.keys(afm).sort().join('')).toBe(MICR_FONT_CHARS)
    expect(MICR_FONT.glyph).toEqual({ transit: 'A', amount: 'B', onUs: 'C', dash: 'D' })
  })

  it('matches the E-13B dimensions at 12 pt: 8 per inch, 0.117" tall, right-aligned, 0.013" module', () => {
    for (const ch of MICR_FONT_CHARS) {
      expect(afm[ch].wx).toBe(MICR_FONT.advance)            // fixed pitch
      expect(afm[ch].xMax).toBe(MICR_FONT.glyphRight)       // every character right-aligned
      expect((afm[ch].xMax - afm[ch].xMin) % MICR_FONT.stemV).toBe(0) // built on the 0.013" module
    }
    expect(MICR_FONT.advance * IN_PER_UNIT).toBeCloseTo(0.125, 3)
    expect(MICR_FONT.height * IN_PER_UNIT).toBeCloseTo(0.117, 3)
    expect(MICR_FONT.stemV * IN_PER_UNIT).toBeCloseTo(0.013, 4)
    // E-13B nominal character widths (inches)
    const width = (ch: string) => (afm[ch].xMax - afm[ch].xMin) * IN_PER_UNIT
    const nominal: Record<string, number> = { '0': 0.091, '1': 0.052, '2': 0.052, '3': 0.065, '4': 0.078, '5': 0.065, '6': 0.078, '7': 0.065, '8': 0.091, '9': 0.078 }
    for (const [ch, w] of Object.entries(nominal)) expect(width(ch)).toBeCloseTo(w, 3)
    for (const d of '0123456789') { expect(afm[d].yMin).toBe(0); expect(afm[d].yMax).toBe(MICR_FONT.height) }
  })
})
