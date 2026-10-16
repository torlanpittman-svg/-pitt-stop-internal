/**
 * Estimate review checks — PURE. Decides whether an estimate can be SENT or INVOICED.
 *
 * Unfinished drafts always SAVE; these checks only gate sending the estimate and creating/syncing
 * the QuickBooks invoice. They never gate job completion (which must not depend on QB/AI).
 *
 * Blocking issues:
 *  - part_labor     a part whose installation labor has not been explicitly resolved
 *  - odor_choice    a line that needs the service chosen before invoicing: generic odor wording or
 *                   wording naming more than one of the three separate odor services (Ozone Treatment,
 *                   Air Duct Cleaning, Odor Treatment), or a line still on the retired "Complete Odor
 *                   Treatment" package. Never reinterpreted automatically.
 *  - name_choice    a legacy line (no catalog identity) whose name matches more than one service
 *                   ("Ceramic Coating" → 1-year or 3-year) — choose one instead of a guess
 *  - service_as_part a physical part saved as an ordinary service line ("Driver-side mirror assembly"),
 *                   so it would skip the installation-labor review — convert it, confirm it is a
 *                   service, or clarify it (part wording with "replace"/"R&R" is never auto-converted)
 * There is no odor package any more, so several odor services on one estimate are normal (no warning).
 */
import { odorWordingNeedsChoice, classifyPartWording, type ServiceRole } from '@/apps/quick-entry/service-interpret'
import { laborReviewSummary } from '@/apps/parts/labor-review'

export interface ReadinessService {
  id: string; title: string; kind: string; catalogId: string | null; role: ServiceRole | null
  matchMethod: string | null
  /** No catalog identity and the name matches more than one service (set by the loader). */
  ambiguousName?: boolean
}
export interface ReadinessPart { id: string; description: string; laborStatus: string }

export type ReadinessCode = 'part_labor' | 'odor_choice' | 'name_choice' | 'service_as_part'
export interface ReadinessIssue { code: ReadinessCode; message: string; ids: string[] }
export interface Readiness { ready: boolean; issues: ReadinessIssue[]; summary: string | null }

/** Why a line must have its service chosen before invoicing (null = it doesn't). */
export type ChoiceReason = 'odor' | 'package' | 'name'
export function serviceChoiceReason(s: ReadinessService): ChoiceReason | null {
  if (s.kind === 'part') return null
  if (s.catalogId) return s.role === 'odor_complete' ? 'package' : null
  // Odor wording always needs one of the three real services — even on a "custom" one-off line, so an
  // obsolete service ("Remove Smoke Odor") can't come back as a custom line.
  if (odorWordingNeedsChoice(s.title)) return 'odor'
  if (s.matchMethod === 'custom') return null
  if (s.ambiguousName) return 'name'
  return null
}

/** A service still needing an odor-service choice (odor wording, or the retired package). */
export function needsOdorChoice(s: ReadinessService): boolean {
  const r = serviceChoiceReason(s)
  return r === 'odor' || r === 'package'
}

/** A service line that reads like a physical part: no catalog identity, not confirmed as a custom
 *  service, and part wording ('part') or part-plus-work wording that needs clarifying ('ambiguous'). */
export function servicePartLike(s: ReadinessService): 'part' | 'ambiguous' | null {
  if (s.kind === 'part' || s.catalogId || s.matchMethod === 'custom') return null
  return classifyPartWording(s.title)
}

/** Issues that can block SYNC of an already-created invoice: only parts labor (new on every job). Legacy
 *  odor wording, the retired package, and ambiguous legacy names never block correcting an invoice. */
export const SYNC_BLOCKING: readonly ReadinessCode[] = ['part_labor']

export function estimateReadiness(services: ReadinessService[], parts: ReadinessPart[]): Readiness {
  const issues: ReadinessIssue[] = []
  const open = parts.filter((p) => p.laborStatus === 'needs_review')
  const laborMsg = laborReviewSummary(open.length)
  if (laborMsg) issues.push({ code: 'part_labor', message: laborMsg, ids: open.map((p) => p.id) })
  const odor = services.filter(needsOdorChoice)
  if (odor.length) {
    const one = odor[0]
    issues.push({ code: 'odor_choice', ids: odor.map((s) => s.id),
      message: odor.length > 1 ? `${odor.length} odor lines need the service chosen.`
        : serviceChoiceReason(one) === 'package'
          ? `“${one.title}” was the Complete Odor Treatment package, which is no longer offered — choose the service performed.`
          : `Choose which service “${one.title}” is.` })
  }
  const named = services.filter((s) => serviceChoiceReason(s) === 'name')
  if (named.length) {
    issues.push({ code: 'name_choice', ids: named.map((s) => s.id),
      message: named.length === 1 ? `“${named[0].title}” matches more than one service — choose which one.` : `${named.length} lines match more than one service — choose which ones.` })
  }
  const partLike = services.filter((s) => servicePartLike(s))
  if (partLike.length) {
    issues.push({ code: 'service_as_part', ids: partLike.map((s) => s.id),
      message: partLike.length === 1
        ? `“${partLike[0].title}” looks like a part — convert it to a part, confirm it is a service, or clarify it.`
        : `${partLike.length} service lines look like parts — convert, confirm as services, or clarify them.` })
  }
  return { ready: issues.length === 0, issues, summary: issues.length ? issues.map((i) => i.message).join(' ') : null }
}
