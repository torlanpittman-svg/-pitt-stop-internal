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
  // PDF re x y w h uses lower-left origin.
  const yPt = (pageHeightIn - (yIn + hIn)) * PT
  return `${widthPt} w ${(xIn * PT).toFixed(2)} ${yPt.toFixed(2)} ${(wIn * PT).toFixed(2)} ${(hIn * PT).toFixed(2)} re S`
}

/** Build a one-page PDF (as a Buffer) from a check print payload. */
export function renderCheckPdf(payload: CheckPrintPayload, opts: { watermark?: string } = {}): Buffer {
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
  if (tpl?.micr && tpl.micr.value) {
    // 'e13b' would use an embedded MICR font (F3) once installed + configured; until then MICR is a
    // clearly non-negotiable placeholder rendered in the normal font. (micrReadiness gates real output.)
    const m = tpl.micr
    ops.push(textOp(m.value, m.xIn, m.yIn, m.sizePt, 'left', 7, H, false))
  }

  const content = ops.join('\n')
  const contentBytes = Buffer.from(content, 'latin1')

  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`
  objects[4] = `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>'
  objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>'

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i <= 6; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 7\n0000000000 65535 f \n`
  for (let i = 1; i <= 6; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return Buffer.from(pdf, 'latin1')
}
