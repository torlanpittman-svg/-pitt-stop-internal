/**
 * Oil-change sticker LAYOUT — pure and client-safe, so the in-app preview and the printed
 * PDF are built from the SAME positioned payload (mirrors the checks render.ts pattern).
 *
 * Physical target: Brother QL-800, DK-2212 white film, 62 mm continuous roll.
 *   - Page width is the full 62 mm tape width; the printer's printable area is 58.9 mm,
 *     so all content stays inside a centered 56 mm band (≥ 2.5 mm side clearance).
 *   - Page HEIGHT is the cut length, computed from the stacked content.
 * Design follows the owner-approved mockup (docs/assets/oil-sticker-approved-mockup.png):
 * centered B/W logo, centered bold "Next service due", calendar icon + large bold date,
 * speedometer icon + large bold mileage, clean white background.
 */
export const STICKER_PAGE_WIDTH_MM = 62
/** Aspect of the print logo master (apps/stickers/assets/pitt-stop-logo-print.png).
 * Kept as constants here (not imported from logo-data.ts) so the client preview bundle
 * never carries the ~100 KB embedded image data; pdf.test.ts asserts they stay in sync. */
export const LOGO_ASPECT_W = 1600
export const LOGO_ASPECT_H = 566
/** QL-800 printable width on 62 mm media (Brother spec: 58.9 mm). */
export const STICKER_PRINTABLE_WIDTH_MM = 58.9
/** Content band: centered, comfortably inside the printable area. */
export const STICKER_CONTENT_WIDTH_MM = 56

const CONTENT_X = (STICKER_PAGE_WIDTH_MM - STICKER_CONTENT_WIDTH_MM) / 2

export interface StickerText {
  value: string
  /** Baseline-left x/y in mm from the page's top-left (pre-resolved from centering). */
  xMm: number
  yMm: number
  sizePt: number
  bold: boolean
}
export interface StickerIcon { kind: 'calendar' | 'gauge'; xMm: number; yMm: number; sizeMm: number }
export interface StickerLogo { xMm: number; yMm: number; wMm: number; hMm: number }

export interface StickerPrintPayload {
  kind: 'oil_sticker'
  stickerId: string
  orderId: string
  pageWidthMm: number
  pageHeightMm: number
  logo: StickerLogo
  texts: StickerText[]
  icons: StickerIcon[]
}

// ── Helvetica metrics (standard PDF base-14 AFM widths, 1/1000 em) ───────────────────────
// Needed so centered text is really centered and row widths are known exactly.
const W_BOLD: Record<string, number> = {
  ' ': 278, ',': 278, '.': 278, '-': 333, ':': 333, '&': 722, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611,
  M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667,
  Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278,
  m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556,
  y: 556, z: 500,
}
const W_REG: Record<string, number> = {
  ...W_BOLD,
  ':': 278, '&': 667,
  A: 667, B: 667, F: 611, J: 500, K: 667, L: 556,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
  m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500,
  y: 500, z: 500,
}

const PT_PER_MM = 72 / 25.4

/** Exact rendered width of a string, in mm, for Helvetica / Helvetica-Bold at `sizePt`. */
export function textWidthMm(value: string, sizePt: number, bold: boolean): number {
  const table = bold ? W_BOLD : W_REG
  let em = 0
  for (const ch of value) em += (table[ch] ?? 556) / 1000
  return (em * sizePt) / PT_PER_MM
}

/** Helvetica cap height ≈ 0.718 em — used to vertically center text against the icons. */
const CAP_HEIGHT_EM = 0.718

export interface StickerValues { nextDateText: string; nextMileageText: string }

/**
 * Build the positioned print payload. The page height (cut length) falls out of the
 * stacked content and is rounded up to a whole millimetre.
 */
export function buildStickerPayload(params: {
  stickerId: string
  orderId: string
  values: StickerValues
}): StickerPrintPayload {
  const { values } = params

  // ── Layout constants (mm) — tuned to the approved mockup's proportions ──
  const topMargin = 2.6
  const logoW = 53
  const logoH = logoW * (LOGO_ASPECT_H / LOGO_ASPECT_W)
  const gapLogoTitle = 2.4
  const titlePt = 13
  const gapTitleRows = 3.0
  const iconSize = 6.4
  const iconTextGap = 2.8
  const rowPt = 19
  const rowGap = 3.0
  const bottomMargin = 3.2

  const texts: StickerText[] = []
  const icons: StickerIcon[] = []

  // Logo — centered
  const logo: StickerLogo = { xMm: (STICKER_PAGE_WIDTH_MM - logoW) / 2, yMm: topMargin, wMm: logoW, hMm: logoH }
  let y = topMargin + logoH + gapLogoTitle

  // Title — centered
  const title = 'Next service due'
  const titleCapMm = (titlePt * CAP_HEIGHT_EM) / PT_PER_MM
  y += titleCapMm
  texts.push({ value: title, xMm: (STICKER_PAGE_WIDTH_MM - textWidthMm(title, titlePt, true)) / 2, yMm: y, sizePt: titlePt, bold: true })
  y += gapTitleRows

  // Icon rows — a left-aligned block (icon column + big bold value), centered as a group
  // on the widest row, like the mockup.
  const rows = [
    { icon: 'calendar' as const, value: values.nextDateText },
    { icon: 'gauge' as const, value: values.nextMileageText },
  ]
  const rowCapMm = (rowPt * CAP_HEIGHT_EM) / PT_PER_MM
  const widest = Math.max(...rows.map((r) => iconSize + iconTextGap + textWidthMm(r.value, rowPt, true)))
  const blockX = Math.max(CONTENT_X, (STICKER_PAGE_WIDTH_MM - widest) / 2)
  for (const row of rows) {
    icons.push({ kind: row.icon, xMm: blockX, yMm: y, sizeMm: iconSize })
    // Baseline so the text's cap-height band is vertically centered on the icon.
    const baseline = y + iconSize / 2 + rowCapMm / 2
    texts.push({ value: row.value, xMm: blockX + iconSize + iconTextGap, yMm: baseline, sizePt: rowPt, bold: true })
    y += iconSize + rowGap
  }
  y -= rowGap // last row has no trailing gap

  const pageHeightMm = Math.ceil(y + bottomMargin)

  return {
    kind: 'oil_sticker',
    stickerId: params.stickerId,
    orderId: params.orderId,
    pageWidthMm: STICKER_PAGE_WIDTH_MM,
    pageHeightMm,
    logo,
    texts,
    icons,
  }
}

/** Runtime shape check for payloads coming back out of the print queue. */
export function isStickerPayload(p: unknown): p is StickerPrintPayload {
  const o = p as StickerPrintPayload
  return !!o && o.kind === 'oil_sticker' && typeof o.stickerId === 'string' && typeof o.orderId === 'string'
    && typeof o.pageWidthMm === 'number' && typeof o.pageHeightMm === 'number'
    && Array.isArray(o.texts) && Array.isArray(o.icons) && !!o.logo
}
