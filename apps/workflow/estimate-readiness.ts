/**
 * Estimate review checks — PURE. Decides whether an estimate can be SENT or INVOICED.
 *
 * Unfinished drafts always SAVE; these checks only gate sending the estimate and creating/syncing
 * the QuickBooks invoice. They never gate job completion (which must not depend on QB/AI).
 *
 * Blocking issues:
 *  - part_labor     a part whose installation labor has not been explicitly resolved
 *  - odor_overlap   Ozone Treatment / Air Duct Cleaning alongside Complete Odor Treatment, which
 *                   already bills both once — replace the separate line or explicitly keep it
 *  - odor_choice    generic odor wording with no chosen treatment ("Odor treatment", "remove smell")
 *  - service_as_part a physical part saved as an ordinary service line ("Driver-side mirror assembly"),
 *                   so it would skip the installation-labor review — convert it, confirm it is a
 *                   service, or clarify it (part wording with "replace"/"R&R" is never auto-converted)
 */
import { odorWordingNeedsChoice, classifyPartWording, type ServiceRole } from '@/apps/quick-entry/service-interpret'
import { laborReviewSummary } from '@/apps/parts/labor-review'

export interface ReadinessService {
  id: string; title: string; kind: string; catalogId: string | null; role: ServiceRole | null
  matchMethod: string | null; overlapAckAt: Date | string | null
}
export interface ReadinessPart { id: string; description: string; laborStatus: string }

export type ReadinessCode = 'part_labor' | 'odor_overlap' | 'odor_choice' | 'service_as_part'
export interface ReadinessIssue { code: ReadinessCode; message: string; ids: string[]; packageId?: string }
export interface Readiness { ready: boolean; issues: ReadinessIssue[]; summary: string | null }

export interface OdorOverlap { packageId: string; overlappingIds: string[] }

/** Separate duct/ozone lines that duplicate a Complete Odor Treatment on the same estimate. */
export function detectOdorOverlap(services: ReadinessService[]): OdorOverlap | null {
  const work = services.filter((s) => s.kind !== 'part')
  const pkg = work.find((s) => s.role === 'odor_complete')
  if (!pkg) return null
  const overlapping = work.filter((s) => s.id !== pkg.id && (s.role === 'odor_duct' || s.role === 'odor_ozone' || s.role === 'odor_complete') && !s.overlapAckAt).map((s) => s.id)
  return overlapping.length ? { packageId: pkg.id, overlappingIds: overlapping } : null
}

/** A service still needing an odor-treatment choice: odor wording, no identity, not a confirmed custom line. */
export function needsOdorChoice(s: ReadinessService): boolean {
  return s.kind !== 'part' && !s.catalogId && s.matchMethod !== 'custom' && odorWordingNeedsChoice(s.title)
}

/** A service line that reads like a physical part: no catalog identity, not confirmed as a custom
 *  service, and part wording ('part') or part-plus-work wording that needs clarifying ('ambiguous'). */
export function servicePartLike(s: ReadinessService): 'part' | 'ambiguous' | null {
  if (s.kind === 'part' || s.catalogId || s.matchMethod === 'custom') return null
  return classifyPartWording(s.title)
}

/** Issues that can block SYNC of an already-created invoice: only ones that cannot exist on historical
 *  jobs (parts and the odor package are new). Legacy odor wording never blocks correcting an invoice. */
export const SYNC_BLOCKING: readonly ReadinessCode[] = ['part_labor', 'odor_overlap']

export function estimateReadiness(services: ReadinessService[], parts: ReadinessPart[]): Readiness {
  const issues: ReadinessIssue[] = []
  const open = parts.filter((p) => p.laborStatus === 'needs_review')
  const laborMsg = laborReviewSummary(open.length)
  if (laborMsg) issues.push({ code: 'part_labor', message: laborMsg, ids: open.map((p) => p.id) })
  const overlap = detectOdorOverlap(services)
  if (overlap) {
    issues.push({ code: 'odor_overlap', packageId: overlap.packageId, ids: overlap.overlappingIds,
      message: 'Complete Odor Treatment already includes air duct cleaning and ozone treatment — replace the separate line or keep it on purpose.' })
  }
  const choice = services.filter(needsOdorChoice)
  if (choice.length) {
    issues.push({ code: 'odor_choice', ids: choice.map((s) => s.id),
      message: choice.length === 1 ? `Choose which odor treatment “${choice[0].title}” means.` : `${choice.length} odor requests need a treatment chosen.` })
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
