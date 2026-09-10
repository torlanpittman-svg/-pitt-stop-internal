/**
 * Full check-FACE template for genuinely BLANK stock (Blue Summit BSS, top position). On blank stock we
 * draw everything ourselves: the company block, bank block, the "PAY TO THE ORDER OF / DATE / DOLLARS /
 * MEMO / SIGNATURE" labels and their lines, the amount box, and the MICR band position — plus the dynamic
 * value fields (from layout.ts) and, when configured, the negotiable MICR line (from micr.ts).
 *
 * All coordinates are inches from the check's own top-left, then shifted by the slot origin + global
 * calibration offset (same model as the value fields). No sensitive data here — routing/account come only
 * from micr.ts. This module contains ONLY the non-sensitive check-face design + the MICR band placement.
 */
import { slotOriginY, DEFAULT_MICR_POS, type CheckLayout } from './layout'

export interface TplText { value: string; xIn: number; yIn: number; sizePt: number; align: 'left' | 'right'; bold?: boolean }
export interface TplLine { x1In: number; y1In: number; x2In: number; y2In: number; widthPt?: number }
export interface TplBox { xIn: number; yIn: number; wIn: number; hIn: number; widthPt?: number }

export interface CheckFaceDisplay {
  companyName: string
  companyAddr?: string | null
  bankName: string
  bankAddr?: string | null
}

export interface MicrRender {
  /** The E-13B-encoded line (font glyphs) for a real negotiable check, OR a plain placeholder string. */
  text: string
  /** 'e13b' = render with the MICR font (negotiable). 'placeholder' = plain, clearly non-negotiable. */
  mode: 'e13b' | 'placeholder'
}

export interface CheckTemplate { texts: TplText[]; lines: TplLine[]; boxes: TplBox[]; micr?: (TplText & { mode: 'e13b' | 'placeholder' }) | null }

/** Build the static face elements for a blank top/middle/bottom check under a layout. */
export function buildCheckTemplate(display: CheckFaceDisplay, layout: CheckLayout, micr?: MicrRender | null): CheckTemplate {
  const oy = slotOriginY(layout.position) + layout.offsetY
  const ox = layout.offsetX
  const T = (value: string, xIn: number, yIn: number, sizePt: number, align: 'left' | 'right' = 'left', bold = false): TplText => ({ value, xIn: xIn + ox, yIn: yIn + oy, sizePt, align, bold })
  const L = (x1In: number, y1In: number, x2In: number, y2In: number, widthPt = 0.75): TplLine => ({ x1In: x1In + ox, y1In: y1In + oy, x2In: x2In + ox, y2In: y2In + oy, widthPt })
  const B = (xIn: number, yIn: number, wIn: number, hIn: number, widthPt = 1): TplBox => ({ xIn: xIn + ox, yIn: yIn + oy, wIn, hIn, widthPt })

  const texts: TplText[] = [
    T(display.companyName, 0.35, 0.30, 12, 'left', true),
  ]
  if (display.companyAddr) texts.push(T(display.companyAddr, 0.35, 0.52, 8))
  texts.push(
    T('DATE', 5.70, 0.40, 7),
    T('PAY TO THE', 0.35, 1.02, 7),
    T('ORDER OF', 0.35, 1.16, 7),
    T('$', 6.35, 1.10, 14, 'left', true),
    T('DOLLARS', 7.55, 1.60, 8, 'right', true),
    T(display.bankName, 0.35, 2.05, 9, 'left', true),
  )
  if (display.bankAddr) texts.push(T(display.bankAddr, 0.35, 2.22, 7))
  texts.push(
    T('MEMO', 0.35, 2.92, 7),
    T('AUTHORIZED SIGNATURE', 5.30, 3.02, 7),
  )

  const lines: TplLine[] = [
    L(5.55, 0.72, 8.10, 0.72),   // date line
    L(1.55, 1.28, 6.30, 1.28),   // payee line
    L(0.30, 1.75, 7.55, 1.75),   // amount-in-words line
    L(0.90, 3.00, 3.30, 3.00),   // memo line
    L(5.30, 2.98, 8.10, 2.98),   // signature line
  ]
  const boxes: TplBox[] = [
    B(6.50, 1.00, 1.62, 0.40),   // amount numeric box
  ]

  let micrEl: CheckTemplate['micr'] = null
  if (micr) {
    micrEl = { value: micr.text, xIn: DEFAULT_MICR_POS.startXIn + ox, yIn: DEFAULT_MICR_POS.yIn + oy, sizePt: DEFAULT_MICR_POS.sizePt, align: 'left', mode: micr.mode }
  }
  return { texts, lines, boxes, micr: micrEl }
}
