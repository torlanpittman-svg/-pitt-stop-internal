/**
 * Phase 2 completion — pure validation for the "Is this vehicle truly finished?"
 * gate. A Job may become Ready only when EVERY assigned service is acknowledged
 * complete AND the general final checks pass (QC only when qc_required). A Job with
 * no services listed cannot silently complete — the employee must add/confirm work.
 */
export interface CompletionPayload {
  servicesAck?: string[]   // service labels the employee affirms are complete
  noRemaining?: boolean    // no remaining/added work unresolved
  finalTouches?: boolean   // final touches complete
  qcPassed?: boolean       // required only when qcRequired
}
export type CompletionError =
  | 'no_services' | 'checklist_required' | 'services_unacknowledged' | 'general_checks' | 'qc_required'
export interface CompletionResult { ok: boolean; error?: CompletionError; missing?: string[] }

export function validateCompletion(
  services: string[] | null | undefined,
  qcRequired: boolean,
  p: CompletionPayload | undefined | null,
): CompletionResult {
  const svc = (services ?? []).map((s) => (s ?? '').trim()).filter(Boolean)
  if (svc.length === 0) return { ok: false, error: 'no_services' }  // must add/confirm work first
  if (!p) return { ok: false, error: 'checklist_required' }
  const ack = new Set((p.servicesAck ?? []).map((s) => (s ?? '').trim().toLowerCase()))
  const missing = svc.filter((s) => !ack.has(s.toLowerCase()))
  if (missing.length > 0) return { ok: false, error: 'services_unacknowledged', missing }
  if (!p.noRemaining || !p.finalTouches) return { ok: false, error: 'general_checks' }
  if (qcRequired && !p.qcPassed) return { ok: false, error: 'qc_required' }
  return { ok: true }
}

// ── Config ───────────────────────────────────────────────────────────────────
export function completionEnabled(): boolean { return process.env.COMPLETION_FLOW_ENABLED === 'true' }
export function shopTimezone(): string { return process.env.SHOP_TIMEZONE || 'America/Chicago' }
