/**
 * Minimal, dependency-free PDF generator for a single check page. A check is just absolutely-positioned
 * text on Letter, so we emit a tiny PDF by hand from the SAME positioned fields the browser preview uses
 * (apps/checks/render.ts). The print bridge fetches this PDF (built server-side in the claim route) and
 * pipes it to the Brother HL-L2420DW.
 *
 * Coordinates: inches → points (×72). PDF origin is bottom-left, so y_pdf = pageHeight − yIn − baseline.
 *
 * MICR (bottom magnetic line) is special — it is rendered to the MICR STANDARD, not with proportional
 * text metrics:
 *   - VERTICAL: `micr.yIn` is the character BASELINE (3/16" above the bottom edge by default).
 *   - HORIZONTAL: `micr.xIn` is the RIGHTMOST character (right-anchored, per ANSI positions-from-right),
 *     and every character advances by exactly `micr.pitchIn` (8 CPI) — positioned individually, never by
 *     the font's own widths.
 *   - FONT: a real (mode 'e13b') line is drawn with the licensed E-13B TrueType font EMBEDDED here
 *     server-side (loaded from MICR_FONT_PATH or MICR_FONT_B64 — never committed to git). If that font is
 *     unavailable, we FAIL CLOSED: no routing/account is ever printed in a normal font; a clearly
 *     non-negotiable placeholder is drawn instead.
 */
import { readFileSync } from 'node:fs'
import type { CheckPrintPayload, RenderedField } from './render'
import type { CheckTemplate } from './template'

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

/**
 * Load the licensed E-13B MICR TrueType font for embedding (server-only). Supports a file path
 * (MICR_FONT_PATH) or a base64-encoded TTF in env (MICR_FONT_B64), so the licensed font need not be
 * committed to git. Returns null if unavailable/unreadable → the caller fails closed to a placeholder.
 */
export function loadMicrFont(): Buffer | null {
  try {
    const b64 = process.env.MICR_FONT_B64
    if (b64 && b64.trim()) return Buffer.from(b64.trim(), 'base64')
    const p = process.env.MICR_FONT_PATH
    if (p && p.trim()) return readFileSync(p.trim())
  } catch { /* fall through */ }
  return null
}

type MicrEl = NonNullable<CheckTemplate['micr']>

/**
 * Content-stream ops for the MICR line, rendered to standard: fixed pitch (8 CPI), right-anchored, baseline
 * at `micr.yIn`. Returns whether the embedded E-13B font (/F3) is actually used so the writer can include
 * the font objects. Fail-closed: a real (e13b) line with no font never prints the routing/account.
 */
function micrOps(micr: MicrEl, pageHeightIn: number): { ops: string[]; embedFont: boolean } {
  const wantReal = micr.mode === 'e13b'
  const font = wantReal ? loadMicrFont() : null
  const embedFont = wantReal && !!font
  const value = wantReal && !embedFont ? 'NON-NEGOTIABLE - MICR FONT NOT INSTALLED' : micr.value
  const fontRef = embedFont ? '/F3' : '/F1'
  const pitch = micr.pitchIn && micr.pitchIn > 0 ? micr.pitchIn : 0.125
  const chars = toLatin1(value).split('')
  const rightX = micr.xIn
  const baseY = micr.yIn
  const yPt = ((pageHeightIn - baseY) * PT).toFixed(2) // baseline directly (no -sizePt for MICR)
  const ops: string[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === ' ') continue // blank MICR position — still consumes one fixed-pitch cell
    const xPt = ((rightX - (chars.length - 1 - i) * pitch) * PT).toFixed(2)
    ops.push(`BT ${fontRef} ${micr.sizePt} Tf ${xPt} ${yPt} Td (${escapePdfText(ch)}) Tj ET`)
  }
  return { ops, embedFont }
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

  let embedFont = false
  if (tpl?.micr && tpl.micr.value) {
    const m = micrOps(tpl.micr, H)
    ops.push(...m.ops)
    embedFont = m.embedFont
  }

  const content = ops.join('\n')
  const contentBytes = Buffer.from(content, 'latin1')

  // Object table — F3 (embedded E-13B TTF) + its descriptor + FontFile2 are appended only when a real
  // MICR line is actually drawn with the licensed font.
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  const fontRes = embedFont ? '/F1 5 0 R /F2 6 0 R /F3 7 0 R' : '/F1 5 0 R /F2 6 0 R'
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /Font << ${fontRes} >> >> /Contents 4 0 R >>`
  objects[4] = `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>'
  objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>'
  if (embedFont) {
    const ttf = loadMicrFont()!
    const first = 32, last = 126
    const widths = new Array(last - first + 1).fill(600).join(' ') // nominal — MICR is positioned per-char
    objects[7] = `<< /Type /Font /Subtype /TrueType /BaseFont /MICRE13B /FirstChar ${first} /LastChar ${last} /Widths [${widths}] /FontDescriptor 8 0 R /Encoding /WinAnsiEncoding >>`
    objects[8] = `<< /Type /FontDescriptor /FontName /MICRE13B /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 9 0 R >>`
    objects[9] = `<< /Length ${ttf.length} /Length1 ${ttf.length} >>\nstream\n${ttf.toString('latin1')}\nendstream`
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
