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
import { slotOriginY, micrPlacement, PAGE_WIDTH_IN, type CheckLayout } from './layout'

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
  /**
   * SECRET-SAFETY: for a REAL check the routing/account MICR line is NOT built at enqueue (it would then
   * persist in the DB print-job payload). Instead we store this (non-secret) check number as a marker and
   * a non-negotiable placeholder; the print-bridge CLAIM route rebuilds the real line from server-only env
   * at print time (resolveDeferredMicr). null ⇒ nothing to defer (test/void or unconfigured).
   */
  deferCheckNumber?: string | number | null
}

// The MICR element carries its own fixed-pitch geometry: `yIn` is the character BASELINE (not the text
// top), `xIn` is the RIGHTMOST character (right-anchored per ANSI), and `pitchIn` is the fixed advance
// (8 CPI). The renderer positions each character individually — never proportional font metrics.
export interface CheckTemplate { texts: TplText[]; lines: TplLine[]; boxes: TplBox[]; micr?: (TplText & { mode: 'e13b' | 'placeholder'; deferCheckNumber?: string | number | null; pitchIn: number }) | null }

/** Build the static face elements for a blank top/middle/bottom check under a layout. */
export function buildCheckTemplate(display: CheckFaceDisplay, layout: CheckLayout, micr?: MicrRender | null): CheckTemplate {
  const oy = slotOriginY(layout.position) + layout.offsetY
  const ox = layout.offsetX
  const S = layout.sectionHeightIn                 // top check-section height (top edge → first perforation)
  const fb = (fromBottomIn: number) => S - fromBottomIn  // y anchored above the first perforation
  const T = (value: string, xIn: number, yIn: number, sizePt: number, align: 'left' | 'right' = 'left', bold = false): TplText => ({ value, xIn: xIn + ox, yIn: yIn + oy, sizePt, align, bold })
  const L = (x1In: number, y1In: number, x2In: number, y2In: number, widthPt = 0.75): TplLine => ({ x1In: x1In + ox, y1In: y1In + oy, x2In: x2In + ox, y2In: y2In + oy, widthPt })
  const B = (xIn: number, yIn: number, wIn: number, hIn: number, widthPt = 1): TplBox => ({ xIn: xIn + ox, yIn: yIn + oy, wIn, hIn, widthPt })

  // ── Upper block (top-anchored) ──
  const texts: TplText[] = [ T(display.companyName, 0.35, 0.30, 12, 'left', true) ]
  if (display.companyAddr) texts.push(T(display.companyAddr, 0.35, 0.52, 8))
  texts.push(
    T('DATE', 5.70, 0.40, 7),
    T('PAY TO THE', 0.35, 1.02, 7),
    T('ORDER OF', 0.35, 1.16, 7),
    T('$', 6.35, 1.06, 14, 'left', true),
    T('DOLLARS', 7.55, 1.50, 8, 'right', true),
    T(display.bankName, 0.35, 1.86, 9, 'left', true),
  )
  if (display.bankAddr) texts.push(T(display.bankAddr, 0.35, 2.03, 7))
  // ── Lower block (bottom-anchored) — compressed UP so memo/signature clear the first perforation. The
  //    MICR band is placed separately by micrPlacement (standards-based: baseline 3/16" above the bottom
  //    edge, right-anchored, 8 CPI), which sits below this block. MEMO label
  //    sits above its line; AUTHORIZED SIGNATURE label sits below its line (both above the MICR band).
  texts.push(
    T('MEMO', 0.35, fb(1.06), 7),
    T('AUTHORIZED SIGNATURE', 5.30, fb(0.90), 7),
  )

  const lines: TplLine[] = [
    L(5.55, 0.68, 8.10, 0.68),                 // date line
    L(1.55, 1.20, 6.30, 1.20),                 // payee line
    L(0.30, 1.66, 7.55, 1.66),                 // amount-in-words line
    L(0.90, fb(1.00), 3.30, fb(1.00)),         // memo line (both memo + signature share this baseline)
    L(5.30, fb(1.00), 8.10, fb(1.00)),         // signature line
  ]
  const boxes: TplBox[] = [ B(6.50, 0.96, 1.62, 0.38) ]  // amount numeric box

  let micrEl: CheckTemplate['micr'] = null
  if (micr) {
    // Standards-based placement: baseline `baselineFromBottomIn` above the perforation, right-anchored,
    // fixed 8 CPI pitch. Global offsets still apply (they're locked at 0 today but honored for consistency).
    const p = micrPlacement(S, PAGE_WIDTH_IN, layout.micr)
    micrEl = {
      value: micr.text, xIn: p.rightAnchorXIn + ox, yIn: p.baselineYIn + oy, sizePt: p.sizePt,
      align: 'right', mode: micr.mode, deferCheckNumber: micr.deferCheckNumber ?? null, pitchIn: p.pitchIn,
    }
  }
  return { texts, lines, boxes, micr: micrEl }
}
