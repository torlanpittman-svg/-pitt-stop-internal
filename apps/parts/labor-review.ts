/**
 * Installation-labor review for special-order and customer-supplied parts — PURE rules.
 *
 * Every part starts `needs_review`. The presence of some labor line on the estimate is NOT enough
 * (painting a mirror does not install it): a part is resolved only by an explicit decision —
 *   labor_added  a NEW installation labor line was added for it (linked by labor_service_id)
 *   included     linked to an EXISTING labor line/package that actually covers installing it
 *   part_only    explicitly supplied without installation
 *   waived       a manager waived installation labor, with a short reason (audited)
 * One labor line may cover several parts (each part links to it). If the covering line is removed
 * or re-matched to different work, the link no longer holds and the review re-opens.
 */
export type LaborStatus = 'needs_review' | 'labor_added' | 'included' | 'part_only' | 'waived'
export const LABOR_STATUSES: readonly LaborStatus[] = ['needs_review', 'labor_added', 'included', 'part_only', 'waived']
export const isLaborStatus = (s: unknown): s is LaborStatus => typeof s === 'string' && (LABOR_STATUSES as readonly string[]).includes(s)

export interface LaborPart { laborStatus: string; laborServiceId: string | null }

/** Status that actually applies now: a link to labor that no longer exists re-opens the review. */
export function effectiveLaborStatus(part: LaborPart, liveLaborServiceIds: ReadonlySet<string>): LaborStatus {
  const s = isLaborStatus(part.laborStatus) ? part.laborStatus : 'needs_review'
  if ((s === 'labor_added' || s === 'included') && (!part.laborServiceId || !liveLaborServiceIds.has(part.laborServiceId))) return 'needs_review'
  return s
}

export const laborResolved = (s: LaborStatus) => s !== 'needs_review'

export const LABOR_LABEL: Record<LaborStatus, string> = {
  needs_review: 'Labor not reviewed',
  labor_added: 'Installation labor added',
  included: 'Installation included',
  part_only: 'Part only — no installation',
  waived: 'Installation labor waived',
}

export const WAIVER_REASON_MIN = 3
export const WAIVER_REASON_MAX = 200

export type LaborDecision =
  | { status: 'labor_added'; serviceId: string }
  | { status: 'included'; serviceId: string }
  | { status: 'part_only' }
  | { status: 'waived'; reason: string }
  | { status: 'needs_review' }

/**
 * Validate a decision against the estimate. `coverable` = live, non-part, non-system services on
 * the SAME estimate (a part's own line can never cover its installation). Returns an error message
 * or null.
 */
export function validateLaborDecision(d: LaborDecision, ctx: { role: string | null; coverable: ReadonlySet<string> }): string | null {
  switch (d.status) {
    case 'labor_added':
    case 'included':
      if (!d.serviceId || !ctx.coverable.has(d.serviceId)) return 'Choose a labor line on this estimate that covers installing this part.'
      return null
    case 'waived': {
      if (ctx.role !== 'manager' && ctx.role !== 'admin') return 'Only a manager can waive installation labor.'
      const r = (d.reason ?? '').replace(/\s+/g, ' ').trim()
      if (r.length < WAIVER_REASON_MIN) return 'Enter a short reason for waiving the labor.'
      if (r.length > WAIVER_REASON_MAX) return `Keep the reason under ${WAIVER_REASON_MAX} characters.`
      return null
    }
    case 'part_only':
    case 'needs_review':
      return null
    default:
      return 'Unknown labor decision.'
  }
}

/** "1 part needs labor review" / "2 parts need labor review". */
export function laborReviewSummary(openCount: number): string | null {
  if (openCount <= 0) return null
  return openCount === 1 ? '1 part needs labor review' : `${openCount} parts need labor review`
}
