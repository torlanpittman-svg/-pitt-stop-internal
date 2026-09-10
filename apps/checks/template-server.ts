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
 * Otherwise returns the template UNCHANGED — the stored non-negotiable placeholder prints (fail closed).
 * The routing/account therefore exist only transiently in the render request, never in the DB.
 */
export function resolveDeferredMicr(template: CheckTemplate | null, cfg: CheckConfig): CheckTemplate | null {
  const micr = template?.micr
  if (!template || !micr || micr.deferCheckNumber == null) return template
  if (!micrReadiness(cfg.micrEnabled).ready) return template
  const encoded = buildMicrLine(micr.deferCheckNumber).encoded
  return { ...template, micr: { ...micr, value: encoded, mode: 'e13b', deferCheckNumber: null } }
}

/** True when a real, negotiable MICR line can currently be printed. */
export function micrIsReady(cfg: CheckConfig): boolean {
  return micrReadiness(cfg.micrEnabled).ready
}
