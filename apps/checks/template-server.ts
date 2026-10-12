/**
 * SERVER-ONLY assembly of the blank-stock check template, including the (secure) MICR line. Kept in its
 * own module so micr.ts (which reads server-only routing/account env) is NEVER pulled into a client
 * bundle. Both the print page (server component) and the queue service call this.
 *
 * MICR safety: a real, negotiable E-13B line is produced ONLY for a real check when micrReadiness().ready
 * (micr_enabled + valid secure routing/account + installed font). Otherwise — and ALWAYS for TEST/VOID —
 * the MICR band is a clearly non-negotiable placeholder, so nobody mistakes an un-encoded print for a
 * cashable check.
 */
import { buildCheckTemplate, type CheckTemplate, type MicrRender, type TplText } from './template'
import { micrReadiness, buildMicrCells, testMicrCells, specimenReadiness, buildSpecimenMicrCells } from './micr'
import { micrFontAvailable } from './micr-font'
import type { CheckConfig } from './config'
import { slotOriginY, MICR_CLEAR_BAND_IN, type CheckLayout } from './layout'

export interface AssembleOpts { test: boolean; checkNumber?: number | string | null; specimen?: boolean }

/**
 * VOID markings for a bank specimen. Printed in solid black as part of the face (not a removable tint),
 * across the middle of the check and over the signature line — and entirely ABOVE the 5/8" MICR clear
 * band, which must stay free of any other ink for the bank's reader. Coordinates are inches from the
 * check's own top-left; `yIn` is the top of the text.
 */
export const SPECIMEN_MARKS: ReadonlyArray<{ value: string; xIn: number; yIn: number; sizePt: number }> = [
  { value: 'VOID - BANK TEST SPECIMEN - NOT NEGOTIABLE', xIn: 2.60, yIn: 1.88, sizePt: 12 },
  { value: 'VOID', xIn: 6.00, yIn: 2.17, sizePt: 22 },
]

/** Build the full face template (or null for pre-printed stock). Includes MICR per the rules above. */
export function assembleCheckTemplate(cfg: CheckConfig, layout: CheckLayout, opts: AssembleOpts): CheckTemplate | null {
  if (cfg.templateMode !== 'blank_full') return null // pre-printed stock: don't draw the face

  let micr: MicrRender | null = null
  if (opts.specimen) {
    // BANK SPECIMEN: same secret-safety as a real check — nothing bank-related is stored; the real line is
    // built at claim time by resolveSpecimenMicr(). The VOID markings are part of the stored face.
    micr = { text: 'NON-NEGOTIABLE — SPECIMEN MICR APPLIED AT SEND', mode: 'placeholder', deferSpecimen: true }
    const tpl = buildCheckTemplate(cfg.display, layout, micr)
    const oy = slotOriginY(layout.position) + layout.offsetY
    const bandTop = layout.sectionHeightIn - MICR_CLEAR_BAND_IN
    for (const m of SPECIMEN_MARKS) {
      if (m.yIn + m.sizePt / 72 > bandTop) throw new Error('specimen marking would enter the MICR clear band')
      tpl.texts.push({ value: m.value, xIn: m.xIn + layout.offsetX, yIn: m.yIn + oy, sizePt: m.sizePt, align: 'left', bold: true } satisfies TplText)
    }
    return tpl
  }
  if (opts.test) {
    // VOID/calibration page: when the E-13B font is available, print a NON-NEGOTIABLE test line (all-zero
    // routing, digit ramp — no bank data) so MICR position + toner can be physically verified.
    micr = micrFontAvailable()
      ? { text: 'NON-NEGOTIABLE TEST', mode: 'e13b', cells: testMicrCells() }
      : { text: 'NON-NEGOTIABLE TEST — MICR LINE PRINTS HERE', mode: 'placeholder' }
  } else if (opts.checkNumber != null) {
    // REAL check: do NOT build the routing/account line here — it would be persisted in the DB print-job
    // payload. Store a non-negotiable placeholder + the (non-secret) check number; resolveDeferredMicr()
    // rebuilds the real E-13B line from server-only env in the CLAIM route, at print time only.
    micr = { text: 'NON-NEGOTIABLE — MICR APPLIED AT SEND', mode: 'placeholder', deferCheckNumber: opts.checkNumber }
  } else {
    micr = { text: 'NON-NEGOTIABLE — MICR NOT CONFIGURED', mode: 'placeholder' }
  }
  return buildCheckTemplate(cfg.display, layout, micr)
}

/**
 * CLAIM-TIME resolution of a deferred MICR line (server-only; reads MICR_ROUTING/MICR_ACCOUNT env). If the
 * job carries a deferred check number AND negotiable printing is fully ready (micr_enabled + valid secure
 * routing/account + installed E-13B font), returns a NEW template whose MICR band is the real E-13B line.
 * Otherwise returns the template UNCHANGED (still deferred) — callers must then REFUSE to print a real
 * check (see renderClaimedJob in service.ts); the placeholder is never a substitute for a MICR line.
 * The routing/account therefore exist only transiently in the render request, never in the DB.
 */
export function resolveDeferredMicr(template: CheckTemplate | null, cfg: CheckConfig): CheckTemplate | null {
  const micr = template?.micr
  if (!template || !micr || micr.deferCheckNumber == null) return template
  if (!micrReadiness(cfg.micrEnabled).ready) return template
  const cells = buildMicrCells(micr.deferCheckNumber)
  return { ...template, micr: { ...micr, value: '', cells, mode: 'e13b', deferCheckNumber: null } }
}

/**
 * CLAIM-TIME resolution of a bank specimen's MICR line (server-only). Returns a NEW template carrying the
 * real routing/account line with check number 000000 when the bank numbers and font are ready; otherwise
 * the template UNCHANGED, and the caller must refuse to print. Independent of micr_enabled by design.
 */
export function resolveSpecimenMicr(template: CheckTemplate | null): CheckTemplate | null {
  const micr = template?.micr
  if (!template || !micr || !micr.deferSpecimen) return template
  if (!specimenReadiness().ready) return template
  return { ...template, micr: { ...micr, value: '', cells: buildSpecimenMicrCells(), mode: 'e13b', deferSpecimen: null } }
}

/** True when a real, negotiable MICR line can currently be printed. */
export function micrIsReady(cfg: CheckConfig): boolean {
  return micrReadiness(cfg.micrEnabled).ready
}
