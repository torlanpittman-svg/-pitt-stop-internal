/**
 * Minimal, dependency-free PDF generator for a single check page. A check is just absolutely-positioned
 * text on Letter, so we emit a tiny PDF by hand from the SAME positioned fields the browser preview uses
 * (apps/checks/render.ts). The print bridge fetches this PDF (built server-side in the claim route) and
 * pipes it to the Brother HL-L2420DW.
 *
 * Coordinates: inches → points (×72). PDF origin is bottom-left, so y_pdf = pageHeight − yIn − baseline.
 *
 * MICR (bottom magnetic line) is special — it is rendered to the MICR STANDARD, not as running text:
 *   - VERTICAL: `micr.yIn` is the character BASELINE (3/16" above the bottom edge by default).
 *   - HORIZONTAL: `micr.xIn` is the RIGHT EDGE of position 14; each character is placed so its own right
 *     edge meets the right edge of its position (E-13B characters are right-aligned), 8 positions/inch.
 *   - FONT: a real (mode 'e13b') line is drawn with the bundled E-13B Type 1 font (micr-font.ts) EMBEDDED
 *     here. If that font is unavailable we FAIL CLOSED: no routing/account is ever printed in a normal
 *     font; a clearly non-negotiable placeholder is drawn instead.
 */
import type { CheckPrintPayload, RenderedField } from './render'
import type { CheckTemplate } from './template'
import { loadMicrFont, MICR_FONT, MICR_FONT_CHARS, type MicrFontData } from './micr-font'
import { micrPositionRightX, MICR_FIRST_PRINTED_POSITION, MICR_CLEAR_BAND_IN, MICR_BAND_BOTTOM_IN, MICR_BAND_TOP_IN } from './layout'

const PT = 72
const AVG_CHAR_EM = 0.5 // rough Times-Roman average advance width per em; fine for short check fields

// Built-in Times-Roman is written with latin1/WinAnsi encoding, so transliterate common non-latin1
// punctuation to ASCII and drop anything else outside the printable latin1 range.
function toLatin1(s: string): string {
  return s
    .replace(/[–—]/g, '-')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
}

function escapePdfText(s: string): string {
  return toLatin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ')
}

function textOp(value: string, xIn: number, yIn: number, sizePt: number, align: 'left' | 'right', widthIn: number, pageHeightIn: number, bold = false): string {
  const estWidthPt = value.length * sizePt * AVG_CHAR_EM
  let xPt = xIn * PT
  if (align === 'right') xPt = (xIn + widthIn) * PT - estWidthPt
  const yPt = (pageHeightIn - yIn) * PT - sizePt
  const font = bold ? '/F2' : '/F1'
  return `BT ${font} ${sizePt} Tf ${xPt.toFixed(2)} ${yPt.toFixed(2)} Td (${escapePdfText(value)}) Tj ET`
}

function fieldToTextOp(f: RenderedField, pageHeightIn: number): string {
  return textOp(f.value, f.xIn, f.yIn, f.sizePt, f.align, f.widthIn, pageHeightIn)
}

function lineOp(x1In: number, y1In: number, x2In: number, y2In: number, pageHeightIn: number, widthPt = 0.75): string {
  const y1 = (pageHeightIn - y1In) * PT, y2 = (pageHeightIn - y2In) * PT
  return `${widthPt} w ${(x1In * PT).toFixed(2)} ${y1.toFixed(2)} m ${(x2In * PT).toFixed(2)} ${y2.toFixed(2)} l S`
}
function boxOp(xIn: number, yIn: number, wIn: number, hIn: number, pageHeightIn: number, widthPt = 1): string {
  const yPt = (pageHeightIn - (yIn + hIn)) * PT
  return `${widthPt} w ${(xIn * PT).toFixed(2)} ${yPt.toFixed(2)} ${(wIn * PT).toFixed(2)} ${(hIn * PT).toFixed(2)} re S`
}

type MicrEl = NonNullable<CheckTemplate['micr']>

/**
 * Content-stream ops for the MICR line. Returns the font to embed (as /F3) when a real E-13B line is
 * drawn. Fail-closed: an 'e13b' line with no usable font, no cells, or any character the font cannot
 * render is replaced by a non-negotiable notice in a normal font — bank digits never print un-encoded.
 */
function micrOps(micr: MicrEl, pageHeightIn: number): { ops: string[]; font: MicrFontData | null } {
  const pitch = micr.pitchIn && micr.pitchIn > 0 ? micr.pitchIn : 0.125
  const yPt = ((pageHeightIn - micr.yIn) * PT).toFixed(2) // baseline directly (no -sizePt for MICR)
  const ops: string[] = []

  if (micr.mode === 'e13b') {
    const font = loadMicrFont()
    const cells = micr.cells ?? []
    const drawable = !!font && cells.length > 0 && cells.every((c) => c.ch.length === 1 && MICR_FONT_CHARS.includes(c.ch) && Number.isInteger(c.pos) && c.pos >= MICR_FIRST_PRINTED_POSITION)
    if (drawable) {
      // Each glyph's right edge is at `glyphRight` font units from its origin.
      const glyphRightIn = (MICR_FONT.glyphRight / MICR_FONT.unitsPerEm) * micr.sizePt / PT
      for (const c of cells) {
        const xPt = ((micrPositionRightX(c.pos, micr.xIn, pitch) - glyphRightIn) * PT).toFixed(3)
        ops.push(`BT /F3 ${micr.sizePt} Tf ${xPt} ${yPt} Td (${c.ch}) Tj ET`)
      }
      return { ops, font }
    }
  }

  // Placeholder (or failed-closed) text: plain font, ending at the position-14 anchor.
  const value = micr.mode === 'e13b' ? 'NON-NEGOTIABLE - MICR FONT NOT AVAILABLE' : micr.value
  const chars = toLatin1(value).split('')
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === ' ') continue
    const xPt = ((micr.xIn - (chars.length - i) * pitch) * PT).toFixed(2)
    ops.push(`BT /F1 ${Math.min(micr.sizePt, 10)} Tf ${xPt} ${yPt} Td (${escapePdfText(chars[i])}) Tj ET`)
  }
  return { ops, font: null }
}

/**
 * CALIBRATION overlay (VOID/test pages only): hairlines for the 5/8" clear band, the 3/16"–7/16" MICR
 * print band, and a tick at the right edge of every MICR position (long ticks at the field boundaries),
 * so a printed sheet can be checked against the standard grid with a ruler — or by eye against a gauge.
 */
function micrGaugeOps(micr: MicrEl, bottomYIn: number, pageWidthIn: number, pageHeightIn: number): string[] {
  const ops: string[] = ['q 0.2 0.5 0.9 RG']
  const pitch = micr.pitchIn && micr.pitchIn > 0 ? micr.pitchIn : 0.125
  for (const up of [MICR_CLEAR_BAND_IN, MICR_BAND_TOP_IN, MICR_BAND_BOTTOM_IN]) ops.push(lineOp(0.15, bottomYIn - up, pageWidthIn - 0.15, bottomYIn - up, pageHeightIn, 0.2))
  const bandTop = bottomYIn - MICR_BAND_TOP_IN
  const fieldEdges = new Set([1, 13, 14, 32, 33, 44, 45])
  for (let pos = 1; pos <= 65; pos++) {
    const x = micrPositionRightX(pos, micr.xIn, pitch)
    if (x < 0.1) break
    ops.push(lineOp(x, bandTop - (fieldEdges.has(pos) ? 0.14 : 0.04), x, bandTop, pageHeightIn, 0.2))
  }
  ops.push('Q')
  return ops
}

/** Build a one-page PDF (as a Buffer) from a check print payload. */
export function renderCheckPdf(payload: CheckPrintPayload, opts: { watermark?: string; micrGauge?: { bottomYIn: number } } = {}): Buffer {
  const wPt = payload.pageWidthIn * PT
  const hPt = payload.pageHeightIn * PT
  const H = payload.pageHeightIn

  const ops: string[] = []
  if (opts.watermark) {
    const size = 30
    ops.push(`q 0.85 0.55 0.55 rg BT /F1 ${size} Tf 0.966 -0.259 0.259 0.966 ${(1.0 * PT).toFixed(2)} ${(H - 2.2) * PT} Tm (${escapePdfText(opts.watermark)}) Tj ET Q`)
  }

  // Static blank-stock template first (lines / boxes / labels), then dynamic values, then MICR.
  const tpl = payload.template
  if (tpl) {
    for (const l of tpl.lines) ops.push(lineOp(l.x1In, l.y1In, l.x2In, l.y2In, H, l.widthPt))
    for (const b of tpl.boxes) ops.push(boxOp(b.xIn, b.yIn, b.wIn, b.hIn, H, b.widthPt))
    for (const t of tpl.texts) if (t.value) ops.push(textOp(t.value, t.xIn, t.yIn, t.sizePt, t.align, 3, H, !!t.bold))
  }
  for (const f of payload.fields) if (f.value) ops.push(fieldToTextOp(f, H))

  let micrFont: MicrFontData | null = null
  if (tpl?.micr && (tpl.micr.value || tpl.micr.cells?.length)) {
    const m = micrOps(tpl.micr, H)
    ops.push(...m.ops)
    micrFont = m.font
    if (opts.micrGauge) ops.push(...micrGaugeOps(tpl.micr, opts.micrGauge.bottomYIn, payload.pageWidthIn, H))
  }
  const embedFont = !!micrFont

  const content = ops.join('\n')
  const contentBytes = Buffer.from(content, 'latin1')

  // Object table — F3 (embedded E-13B Type 1 font) + its descriptor + FontFile are appended only when a
  // real MICR line is actually drawn with it.
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  const fontRes = embedFont ? '/F1 5 0 R /F2 6 0 R /F3 7 0 R' : '/F1 5 0 R /F2 6 0 R'
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /Font << ${fontRes} >> >> /Contents 4 0 R >>`
  objects[4] = `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>'
  objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>'
  if (micrFont) {
    const F = MICR_FONT
    const widths = new Array(F.lastChar - F.firstChar + 1).fill(F.advance).join(' ')
    // Symbolic font (Flags: FixedPitch + Symbolic) with NO /Encoding entry → the font's own built-in
    // encoding is used, so codes '0'-'9' / 'A'-'D' select exactly the glyphs the font defines there.
    objects[7] = `<< /Type /Font /Subtype /Type1 /BaseFont /${F.name} /FirstChar ${F.firstChar} /LastChar ${F.lastChar} /Widths [${widths}] /FontDescriptor 8 0 R >>`
    objects[8] = `<< /Type /FontDescriptor /FontName /${F.name} /Flags 5 /FontBBox [${F.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${F.height} /Descent 0 /CapHeight ${F.height} /StemV ${F.stemV} /FontFile 9 0 R >>`
    const program = Buffer.concat([micrFont.clear, micrFont.encrypted, micrFont.trailer])
    objects[9] = `<< /Length ${program.length} /Length1 ${micrFont.clear.length} /Length2 ${micrFont.encrypted.length} /Length3 ${micrFont.trailer.length} >>\nstream\n${program.toString('latin1')}\nendstream`
  }
  const N = embedFont ? 9 : 6

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i <= N; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${N + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= N; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${N + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return Buffer.from(pdf, 'latin1')
}
