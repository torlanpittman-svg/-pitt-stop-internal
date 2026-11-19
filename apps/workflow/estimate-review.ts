/**
 * Loads the estimate review state (parts labor review, odor/ambiguous-name choices, part-like lines) for an
 * order and evaluates it with the pure rules in estimate-readiness.ts. Read-only.
 *
 * Used by: the estimate view (visible notices), estimate SEND, and retail QuickBooks invoice
 * CREATE / SYNC (which refuse until every issue is explicitly resolved). Never used by job
 * completion.
 */
import { getDb } from '@/platform/db'
import { and, eq, ne, inArray, sql, type SQL } from 'drizzle-orm'
import { jobEstimates, jobServices } from './schema'
import { jobParts } from '@/apps/parts/schema'
import { serviceCatalog } from '@/apps/quick-entry/schema'
import { ambiguousServiceKeys, normalizeServiceKey } from '@/apps/quick-entry/catalog-identity'
import { estimateReadiness, type Readiness, type ReadinessService, type ReadinessPart } from './estimate-readiness'
import { effectiveLaborStatus } from '@/apps/parts/labor-review'
import type { ServiceRole } from '@/apps/quick-entry/service-interpret'

/**
 * THE rule for "this estimate line can cover installing a part" — the only definition. A real work
 * line (not the system fee row, not a part's own row) that the customer has not declined: a declined
 * line is not work being performed, so it covers nothing. Everything that asks the question uses this
 * one condition: the review state below (a part linked to a line that stops qualifying is open
 * again), the labor-line choices on screen, and every labor decision / part attachment at the moment
 * it is saved (apps/parts/estimate-parts.ts, including inside the bulk statement).
 */
export const coverableServiceWhere: SQL = and(ne(jobServices.source, 'system'), ne(jobServices.kind, 'part'), ne(jobServices.approvalState, 'declined'))!

/** Lines on this order's estimate that can cover installation right now. */
export async function coverableServiceIds(orderId: string): Promise<Set<string>> {
  const rows = await getDb().select({ id: jobServices.id }).from(jobServices)
    .innerJoin(jobEstimates, eq(jobEstimates.id, jobServices.jobEstimateId))
    .where(and(eq(jobEstimates.serviceOrderId, orderId), coverableServiceWhere))
  return new Set(rows.map((r) => r.id))
}

export const LABOR_LINE_GONE_MSG = 'That labor line is no longer available on this invoice (it was removed or declined). No parts were changed — refresh and choose another line.'

export interface EstimateReviewState {
  services: ReadinessService[]
  parts: (ReadinessPart & { laborServiceId: string | null })[]
  readiness: Readiness
}

export async function loadEstimateReview(orderId: string): Promise<EstimateReviewState> {
  const db = getDb()
  const [est] = await db.select({ id: jobEstimates.id }).from(jobEstimates).where(eq(jobEstimates.serviceOrderId, orderId)).limit(1)
  const svcRows = est
    ? await db.select({
      id: jobServices.id, title: jobServices.title, kind: jobServices.kind, catalogId: jobServices.catalogId,
      matchMethod: jobServices.matchMethod, role: serviceCatalog.serviceRole,
      coverable: sql<boolean>`${coverableServiceWhere}`,
    }).from(jobServices).leftJoin(serviceCatalog, eq(serviceCatalog.id, jobServices.catalogId))
      .where(and(eq(jobServices.jobEstimateId, est.id), ne(jobServices.source, 'system')))
    : []
  // Legacy lines with no identity whose name matches more than one service are reviewed, not guessed.
  const ambiguous = svcRows.some((s) => !s.catalogId) ? await ambiguousServiceKeys() : new Set<string>()
  const services: ReadinessService[] = svcRows.map((s) => ({ id: s.id, title: s.title, kind: s.kind, catalogId: s.catalogId, matchMethod: s.matchMethod,
    role: (s.role as ServiceRole | null) ?? null,
    ambiguousName: !s.catalogId && ambiguous.has(normalizeServiceKey(s.title)) }))
  const partRows = await db.select().from(jobParts).where(and(eq(jobParts.serviceOrderId, orderId), ne(jobParts.status, 'cancelled')))
  const coverable = new Set(svcRows.filter((s) => s.coverable).map((s) => s.id))
  const parts = partRows.map((p) => ({
    id: p.id, description: p.description, laborServiceId: p.laborServiceId,
    laborStatus: effectiveLaborStatus(p, coverable),
  }))
  return { services, parts, readiness: estimateReadiness(services, parts) }
}

/** Throw a plain-language error when the estimate isn't ready to send/invoice. */
export async function assertEstimateReady(orderId: string, action: 'send' | 'invoice'): Promise<void> {
  const { readiness } = await loadEstimateReview(orderId)
  if (readiness.ready) return
  const verb = action === 'send' ? 'sending the estimate' : 'creating the invoice'
  throw new EstimateNotReadyError(`Resolve before ${verb}: ${readiness.summary}`)
}

export class EstimateNotReadyError extends Error {
  constructor(message: string) { super(message); this.name = 'EstimateNotReadyError' }
}

/** Services on these ids (helper for callers that need to validate links). */
export async function servicesByIds(ids: string[]) {
  if (ids.length === 0) return []
  return getDb().select().from(jobServices).where(inArray(jobServices.id, ids))
}
