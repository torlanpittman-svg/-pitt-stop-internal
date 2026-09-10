/**
 * Minimal, dependency-free PDF generator for a single check page. A check is just absolutely-positioned
 * text on Letter, so we emit a tiny PDF by hand (one built-in Times-Roman font, no embedding) from the
 * SAME positioned fields the browser preview uses (apps/checks/render.ts). The print bridge fetches this
 * PDF and pipes it to CUPS (`lp`) on the Brother HL-L2420DW.
 *
 * Coordinates: inches → points (×72). PDF origin is bottom-left, so y_pdf = pageHeight − yIn − baseline.
 * Right-aligned fields are shifted left by an estimated text width (Times-Roman avg ≈ 0.5em); the global
 * calibration offset absorbs any small residual. No bank routing/account/MICR is ever drawn.
 */
import type { CheckPrintPayload, RenderedField } from './render'

const PT = 72
const AVG_CHAR_EM = 0.5 // rough Times-Roman average advance width per em; fine for short check fields

// Built-in Times-Roman is written with latin1/WinAnsi encoding, so transliterate common non-latin1
// punctuation to ASCII (em/en dashes, smart quotes, ellipsis) and drop anything else outside the
// printable latin1 range — otherwise those glyphs vanish or corrupt the text stream.
function toLatin1(s: string): string {
  return s
    .replace(/[–—]/g, '-')       // – —  → -
    .replace(/[‘’′]/g, "'") // ' ' ′ → '
    .replace(/[“”″]/g, '"') // " " ″ → "
    .replace(/…/g, '...')             // …    → ...
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '') // drop remaining non-latin1
}

function escapePdfText(s: string): string {
  return toLatin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ')
}

function fieldToTextOp(f: RenderedField, pageHeightIn: number): string {
  const size = f.sizePt
  const estWidthPt = f.value.length * size * AVG_CHAR_EM
  let xPt = f.xIn * PT
  if (f.align === 'right') xPt = (f.xIn + f.widthIn) * PT - estWidthPt
  // Baseline sits slightly below the field's top edge.
  const yPt = (pageHeightIn - f.yIn) * PT - size
  return `BT /F1 ${size} Tf ${xPt.toFixed(2)} ${yPt.toFixed(2)} Td (${escapePdfText(f.value)}) Tj ET`
}

/** Build a one-page PDF (as a Buffer) from a check print payload. */
export function renderCheckPdf(payload: CheckPrintPayload, opts: { watermark?: string } = {}): Buffer {
  const wPt = payload.pageWidthIn * PT
  const hPt = payload.pageHeightIn * PT

  const ops: string[] = []
  if (opts.watermark) {
    // Light, rotated VOID watermark (test prints only).
    const size = 34
    ops.push(`q 0.85 0.55 0.55 rg BT /F1 ${size} Tf 0.966 -0.259 0.259 0.966 ${(1.0 * PT).toFixed(2)} ${(payload.pageHeightIn - 2.2) * PT} Tm (${escapePdfText(opts.watermark)}) Tj ET Q`)
  }
  for (const f of payload.fields) if (f.value) ops.push(fieldToTextOp(f, payload.pageHeightIn))
  const content = ops.join('\n')
  const contentBytes = Buffer.from(content, 'latin1')

  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`
  objects[4] = `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>'

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return Buffer.from(pdf, 'latin1')
}
