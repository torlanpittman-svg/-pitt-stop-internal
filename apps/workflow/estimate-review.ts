/**
 * Loads the estimate review state (parts labor review, odor package overlap, odor choice) for an
 * order and evaluates it with the pure rules in estimate-readiness.ts. Read-only.
 *
 * Used by: the estimate view (visible notices), estimate SEND, and retail QuickBooks invoice
 * CREATE / SYNC (which refuse until every issue is explicitly resolved). Never used by job
 * completion.
 */
import { getDb } from '@/platform/db'
import { and, eq, ne, inArray } from 'drizzle-orm'
import { jobEstimates, jobServices } from './schema'
import { jobParts } from '@/apps/parts/schema'
import { serviceCatalog } from '@/apps/quick-entry/schema'
import { estimateReadiness, type Readiness, type ReadinessService, type ReadinessPart } from './estimate-readiness'
import { effectiveLaborStatus } from '@/apps/parts/labor-review'
import type { ServiceRole } from '@/apps/quick-entry/service-interpret'

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
      matchMethod: jobServices.matchMethod, overlapAckAt: jobServices.overlapAckAt, role: serviceCatalog.serviceRole,
    }).from(jobServices).leftJoin(serviceCatalog, eq(serviceCatalog.id, jobServices.catalogId))
      .where(and(eq(jobServices.jobEstimateId, est.id), ne(jobServices.source, 'system')))
    : []
  const services: ReadinessService[] = svcRows.map((s) => ({ ...s, role: (s.role as ServiceRole | null) ?? null }))
  const partRows = await db.select().from(jobParts).where(and(eq(jobParts.serviceOrderId, orderId), ne(jobParts.status, 'cancelled')))
  const coverable = new Set(services.filter((s) => s.kind !== 'part').map((s) => s.id))
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
