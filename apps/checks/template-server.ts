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
import { buildCheckTemplate, type CheckTemplate, type MicrRender } from './template'
import { micrReadiness, buildMicrLine } from './micr'
import type { CheckConfig } from './config'
import type { CheckLayout } from './layout'

export interface AssembleOpts { test: boolean; checkNumber?: number | string | null }

/** Build the full face template (or null for pre-printed stock). Includes MICR per the rules above. */
export function assembleCheckTemplate(cfg: CheckConfig, layout: CheckLayout, opts: AssembleOpts): CheckTemplate | null {
  if (cfg.templateMode !== 'blank_full') return null // pre-printed stock: don't draw the face

  let micr: MicrRender | null = null
  if (opts.test) {
    micr = { text: 'NON-NEGOTIABLE TEST — MICR LINE PRINTS HERE', mode: 'placeholder' }
  } else {
    const r = micrReadiness(cfg.micrEnabled)
    if (r.ready && opts.checkNumber != null) {
      micr = { text: buildMicrLine(opts.checkNumber).encoded, mode: 'e13b' }
    } else {
      micr = { text: 'NON-NEGOTIABLE — MICR NOT CONFIGURED', mode: 'placeholder' }
    }
  }
  return buildCheckTemplate(cfg.display, layout, micr)
}

/** True when a real, negotiable MICR line can currently be printed. */
export function micrIsReady(cfg: CheckConfig): boolean {
  return micrReadiness(cfg.micrEnabled).ready
}
