/**
 * Completion — pure validation for Finish Job. One explicit confirmation, "All work is complete and
 * this vehicle is ready." (owner decision 2026-10-20: the per-service checkboxes and the extra final-check
 * boxes are gone). A Job with no work listed still cannot silently complete — the work must be on the
 * Job first. When the Job requires QC, a SEPARATE explicit QC pass is still required; the confirmation is
 * never treated as one. `services` = the Job's WORK services (parts excluded — see apps/parts/job-items).
 */
export interface CompletionPayload {
  allWorkComplete?: boolean   // the single confirmation
  qcPassed?: boolean          // required only when qcRequired
}
export type CompletionError = 'no_services' | 'checklist_required' | 'confirmation_required' | 'qc_required'
export interface CompletionResult { ok: boolean; error?: CompletionError }

export function validateCompletion(
  services: string[] | null | undefined,
  qcRequired: boolean,
  p: CompletionPayload | undefined | null,
): CompletionResult {
  const svc = (services ?? []).map((s) => (s ?? '').trim()).filter(Boolean)
  if (svc.length === 0) return { ok: false, error: 'no_services' }  // must add/confirm work first
  if (!p) return { ok: false, error: 'checklist_required' }
  if (p.allWorkComplete !== true) return { ok: false, error: 'confirmation_required' }
  if (qcRequired && p.qcPassed !== true) return { ok: false, error: 'qc_required' }
  return { ok: true }
}

/** The completion record stored on the Job — the validated answers only (no client-supplied extras). */
export function completionRecord(qcRequired: boolean, p: CompletionPayload, by: string | null, at: Date = new Date()): Record<string, unknown> {
  return { allWorkComplete: p.allWorkComplete === true, ...(qcRequired ? { qcPassed: p.qcPassed === true } : {}), at: at.toISOString(), by }
}

// ── Config ───────────────────────────────────────────────────────────────────
export function completionEnabled(): boolean { return process.env.COMPLETION_FLOW_ENABLED === 'true' }
export function shopTimezone(): string { return process.env.SHOP_TIMEZONE || 'America/Chicago' }
