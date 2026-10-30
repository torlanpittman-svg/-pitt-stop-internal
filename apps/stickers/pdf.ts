/**
 * Minimal, dependency-free PDF generator for one oil-change sticker page (same hand-rolled
 * approach as apps/checks/pdf.ts, deliberately NOT shared with it — sticker rendering must
 * never touch check/MICR code). The page is exactly the label: 62 mm wide × the computed
 * cut length, so the bridge prints it at actual size (SumatraPDF `noscale,paper=auto`) on
 * the QL-800 and the driver cuts the DK-2212 roll at the page edge.
 *
 * The logo is the processed black-on-white master (logo-data.ts): zlib-deflated raw 8-bit
 * grayscale embedded as a FlateDecode image XObject — lossless, no JPEG ringing, crisp at
 * the printer's 300 dpi. Icons are drawn as vector paths.
 */
import { LOGO_WIDTH_PX, LOGO_HEIGHT_PX, LOGO_GRAY_DEFLATED_BASE64 } from './logo-data'
import type { StickerPrintPayload, StickerIcon } from './render'

const PT_PER_MM = 72 / 25.4
const mm = (v: number) => v * PT_PER_MM

function escapePdfText(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** Circle approximated with 4 Béziers; returns path ops (no paint op). */
function circlePath(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r
  return [
    `${(cx + r).toFixed(2)} ${cy.toFixed(2)} m`,
    `${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c`,
    `${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} c`,
    `${(cx - r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy - r).toFixed(2)} ${cx.toFixed(2)} ${(cy - r).toFixed(2)} c`,
    `${(cx + k).toFixed(2)} ${(cy - r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c`,
  ].join('\n')
}

/** Calendar outline icon (matches the approved mockup): body, two binder rings, 2×3 date dots. */
function calendarOps(xPt: number, yTopPt: number, sPt: number): string {
  const stroke = sPt * 0.1
  const x = xPt, y = yTopPt // y decreases downward handled by caller: yTopPt is PDF y of the icon TOP
  const bodyTop = y - sPt * 0.16
  const bodyBot = y - sPt
  const ops: string[] = [`${stroke.toFixed(2)} w 1 J`]
  // body
  ops.push(`${x.toFixed(2)} ${bodyBot.toFixed(2)} ${sPt.toFixed(2)} ${(bodyTop - bodyBot).toFixed(2)} re S`)
  // binder rings
  for (const fx of [0.28, 0.72]) {
    ops.push(`${(x + sPt * fx).toFixed(2)} ${(y - sPt * 0.3).toFixed(2)} m ${(x + sPt * fx).toFixed(2)} ${y.toFixed(2)} l S`)
  }
  // header separator
  const headY = y - sPt * 0.42
  ops.push(`${x.toFixed(2)} ${headY.toFixed(2)} m ${(x + sPt).toFixed(2)} ${headY.toFixed(2)} l S`)
  // 2×3 date dots (filled squares)
  const d = sPt * 0.12
  for (const fy of [0.58, 0.8]) {
    for (const fx of [0.18, 0.44, 0.7]) {
      ops.push(`${(x + sPt * fx).toFixed(2)} ${(y - sPt * fy - d).toFixed(2)} ${d.toFixed(2)} ${d.toFixed(2)} re f`)
    }
  }
  return ops.join('\n')
}

/** Speedometer outline icon: upper semicircle on a flat base, needle to upper-left, hub dot. */
function gaugeOps(xPt: number, yTopPt: number, sPt: number): string {
  const stroke = sPt * 0.1
  const r = sPt * 0.44
  const cx = xPt + sPt / 2
  const cy = yTopPt - sPt * 0.68 // arc center sits low so the dome fills the box
  const k = 0.5523 * r
  const ops: string[] = [`${stroke.toFixed(2)} w 1 J 1 j`]
  // dome: left base → top → right base (two Béziers)
  ops.push(`${(cx - r).toFixed(2)} ${cy.toFixed(2)} m`)
  ops.push(`${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c`)
  ops.push(`${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c`)
  // flat base
  ops.push(`${(cx + r).toFixed(2)} ${cy.toFixed(2)} m ${(cx - r).toFixed(2)} ${cy.toFixed(2)} l S`)
  // needle toward upper-left (135°)
  const nx = cx - r * 0.62 * Math.SQRT1_2, ny = cy + r * 0.62 * Math.SQRT1_2
  ops.push(`${cx.toFixed(2)} ${cy.toFixed(2)} m ${nx.toFixed(2)} ${ny.toFixed(2)} l S`)
  // hub
  ops.push(circlePath(cx, cy, stroke * 0.9))
  ops.push('f')
  return ops.join('\n')
}

function iconOps(icon: StickerIcon, pageHmm: number): string {
  const x = mm(icon.xMm)
  const yTop = mm(pageHmm - icon.yMm)
  const s = mm(icon.sizeMm)
  return icon.kind === 'calendar' ? calendarOps(x, yTop, s) : gaugeOps(x, yTop, s)
}

/** Render the sticker payload to a complete single-page PDF. */
export function renderStickerPdf(payload: StickerPrintPayload): Buffer {
  const Wpt = mm(payload.pageWidthMm)
  const Hpt = mm(payload.pageHeightMm)

  const content: string[] = []
  // Logo image: unit square CTM scaled to placement box.
  const lw = mm(payload.logo.wMm), lh = mm(payload.logo.hMm)
  const lx = mm(payload.logo.xMm), ly = mm(payload.pageHeightMm - payload.logo.yMm - payload.logo.hMm)
  content.push(`q ${lw.toFixed(2)} 0 0 ${lh.toFixed(2)} ${lx.toFixed(2)} ${ly.toFixed(2)} cm /Im1 Do Q`)
  for (const t of payload.texts) {
    const x = mm(t.xMm), y = mm(payload.pageHeightMm - t.yMm)
    content.push(`BT ${t.bold ? '/F2' : '/F1'} ${t.sizePt} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdfText(t.value)}) Tj ET`)
  }
  for (const icon of payload.icons) content.push(iconOps(icon, payload.pageHeightMm))
  const stream = content.join('\n')

  const logoData = Buffer.from(LOGO_GRAY_DEFLATED_BASE64, 'base64')

  const objects: (string | Buffer)[] = []
  const push = (s: string | Buffer) => objects.push(s)
  push('<< /Type /Catalog /Pages 2 0 R >>')
  push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Wpt.toFixed(2)} ${Hpt.toFixed(2)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 4 0 R >>`)
  push(Buffer.concat([
    Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n`),
    Buffer.from(stream),
    Buffer.from('\nendstream'),
  ]))
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
  push(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${LOGO_WIDTH_PX} /Height ${LOGO_HEIGHT_PX} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${logoData.length} >>\nstream\n`),
    logoData,
    Buffer.from('\nendstream'),
  ]))

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  const offsets: number[] = []
  let pos = chunks[0].length
  objects.forEach((obj, i) => {
    offsets.push(pos)
    const head = Buffer.from(`${i + 1} 0 obj\n`)
    const body = typeof obj === 'string' ? Buffer.from(obj) : obj
    const tail = Buffer.from('\nendobj\n')
    chunks.push(head, body, tail)
    pos += head.length + body.length + tail.length
  })
  const xrefPos = pos
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefPos),
    '%%EOF',
  ].join('\n')
  chunks.push(Buffer.from(xref))
  return Buffer.concat(chunks)
}
