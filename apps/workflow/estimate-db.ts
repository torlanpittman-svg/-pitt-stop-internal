/**
 * Phase 3 estimate repository. Manager-gating is enforced at the API layer.
 * No QuickBooks/AutoLeap writes. Totals are recomputed by the pure engine and
 * cached on job_estimates after every mutation.
 */
import { getDb } from '@/platform/db'
import { eq, asc, inArray } from 'drizzle-orm'
import { jobEstimates, jobServices, jobLineItems, serviceOrders, serviceOrderEvents } from './schema'
import {
  computeTotals, rollUpDecision, defaultTaxForType, defaultTaxBps, approvedTitlesToSync, convertSyncsServices,
  type LineType, type ApprovalState, type EstimateStatus, type TaxCategory,
} from './estimate'

export type EstimateRow = typeof jobEstimates.$inferSelect
export type JobServiceRow = typeof jobServices.$inferSelect
export type JobLineRow = typeof jobLineItems.$inferSelect
export interface FullEstimate { estimate: EstimateRow; services: (JobServiceRow & { lines: JobLineRow[] })[] }

async function logJobEvent(orderId: string, eventType: string, actor: string | null, note: string | null) {
  await getDb().insert(serviceOrderEvents).values({ serviceOrderId: orderId, eventType, employeeName: actor, note })
}

export async function getEstimateRow(orderId: string): Promise<EstimateRow | null> {
  const [e] = await getDb().select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, orderId)).limit(1)
  return e ?? null
}

export async function getOrCreateEstimate(orderId: string, actor: string | null): Promise<EstimateRow> {
  const existing = await getEstimateRow(orderId)
  if (existing) return existing
  const db = getDb()
  const [row] = await db.insert(jobEstimates).values({ serviceOrderId: orderId, taxRateBps: defaultTaxBps(), status: 'draft', createdBy: actor, updatedBy: actor }).returning()
  await logJobEvent(orderId, 'estimate_started', actor, null)
  return row
}

export async function getFullEstimate(orderId: string): Promise<FullEstimate | null> {
  const estimate = await getEstimateRow(orderId)
  if (!estimate) return null
  const db = getDb()
  const svcs = await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, estimate.id)).orderBy(asc(jobServices.sortOrder), asc(jobServices.createdAt))
  const svcIds = svcs.map((s) => s.id)
  const lines = svcIds.length
    ? await db.select().from(jobLineItems).where(inArray(jobLineItems.jobServiceId, svcIds)).orderBy(asc(jobLineItems.sortOrder), asc(jobLineItems.createdAt))
    : []
  const byService: Record<string, JobLineRow[]> = {}
  for (const l of lines) (byService[l.jobServiceId] ??= []).push(l)
  return { estimate, services: svcs.map((s) => ({ ...s, lines: byService[s.id] ?? [] })) }
}

/** Recompute cached totals + needs_tax_review from all lines under the estimate. */
export async function recomputeEstimate(estimateId: string): Promise<void> {
  const db = getDb()
  const svcs = await db.select({ id: jobServices.id }).from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
  const ids = svcs.map((s) => s.id)
  const lines = ids.length ? await db.select().from(jobLineItems).where(inArray(jobLineItems.jobServiceId, ids)) : []
  const [est] = await db.select({ rate: jobEstimates.taxRateBps, discount: jobEstimates.discountCents }).from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  const t = computeTotals(lines.map((l) => ({ priceCents: l.priceCents, qty: l.qty, taxable: l.taxable, taxCategory: l.taxCategory })), est?.rate ?? defaultTaxBps(), est?.discount ?? 0)
  await db.update(jobEstimates).set({
    taxableSubtotalCents: t.taxableSubtotalCents, nontaxableSubtotalCents: t.nontaxableSubtotalCents,
    taxCents: t.taxCents, totalCents: t.totalCents, needsTaxReview: t.needsTaxReview, updatedAt: new Date(),
  }).where(eq(jobEstimates.id, estimateId))
}

/** Seed job_services from the Job's employee-facing text services (idempotent). */
export async function promoteTextServices(estimateId: string, orderId: string): Promise<number> {
  const db = getDb()
  const [order] = await db.select({ services: serviceOrders.services }).from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  const text = (order?.services ?? []).map((s) => s.trim()).filter(Boolean)
  if (text.length === 0) return 0
  const existing = await db.select({ title: jobServices.title }).from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
  const have = new Set(existing.map((s) => s.title.trim().toLowerCase()))
  let n = 0
  for (const [i, title] of text.entries()) {
    if (have.has(title.toLowerCase())) continue
    await db.insert(jobServices).values({ jobEstimateId: estimateId, title, source: 'promoted', sortOrder: i })
    n++
  }
  return n
}

export async function addService(estimateId: string, title: string): Promise<JobServiceRow> {
  const [row] = await getDb().insert(jobServices).values({ jobEstimateId: estimateId, title: title.trim(), source: 'manual' }).returning()
  return row
}
export async function updateService(id: string, patch: Partial<Pick<JobServiceRow, 'title' | 'technician' | 'notes' | 'approvalState' | 'sortOrder'>>): Promise<void> {
  await getDb().update(jobServices).set({ ...patch, updatedAt: new Date() }).where(eq(jobServices.id, id))
}
export async function removeService(id: string): Promise<void> {
  await getDb().delete(jobServices).where(eq(jobServices.id, id))
}

export interface LineInput {
  type: LineType; name: string; description?: string | null; qty?: number | string; unit?: string
  costCents?: number; priceCents?: number; taxable?: boolean; taxCategory?: TaxCategory
  partNumber?: string | null; brand?: string | null; supplier?: string | null; provider?: string | null; providerRef?: string | null
}
export async function addLine(serviceId: string, input: LineInput): Promise<JobLineRow> {
  const def = defaultTaxForType(input.type)
  const [row] = await getDb().insert(jobLineItems).values({
    jobServiceId: serviceId, type: input.type, name: input.name.trim(), description: input.description ?? null,
    qty: String(input.qty ?? 1), unit: input.unit ?? (input.type === 'labor' ? 'hours' : 'each'),
    costCents: input.costCents ?? 0, priceCents: input.priceCents ?? 0,
    taxable: input.taxable ?? def.taxable, taxCategory: input.taxCategory ?? def.taxCategory,
    partNumber: input.partNumber ?? null, brand: input.brand ?? null, supplier: input.supplier ?? null,
    provider: input.provider ?? null, providerRef: input.providerRef ?? null,
  }).returning()
  return row
}
export async function updateLine(id: string, patch: Partial<{ name: string; description: string | null; qty: number | string; unit: string; costCents: number; priceCents: number; taxable: boolean; taxCategory: TaxCategory }>): Promise<void> {
  const set: Record<string, unknown> = { ...patch }
  if (patch.qty !== undefined) set.qty = String(patch.qty)
  await getDb().update(jobLineItems).set(set).where(eq(jobLineItems.id, id))
}
export async function removeLine(id: string): Promise<void> {
  await getDb().delete(jobLineItems).where(eq(jobLineItems.id, id))
}

export async function setTaxRate(estimateId: string, bps: number): Promise<void> {
  await getDb().update(jobEstimates).set({ taxRateBps: Math.max(0, Math.round(bps)), updatedAt: new Date() }).where(eq(jobEstimates.id, estimateId))
}
export async function setStatus(estimateId: string, orderId: string, status: EstimateStatus, actor: string | null): Promise<void> {
  const patch: Record<string, unknown> = { status, updatedAt: new Date(), updatedBy: actor }
  if (status === 'sent') patch.sentAt = new Date()
  await getDb().update(jobEstimates).set(patch).where(eq(jobEstimates.id, estimateId))
  await logJobEvent(orderId, 'estimate_status', actor, status)
}

/** Set a service's decision, then roll the estimate status up from all decisions. */
export async function setApproval(estimateId: string, orderId: string, serviceId: string, state: ApprovalState, actor: string | null): Promise<EstimateStatus> {
  const db = getDb()
  await db.update(jobServices).set({ approvalState: state, updatedAt: new Date() }).where(eq(jobServices.id, serviceId))
  const svcs = await db.select({ s: jobServices.approvalState }).from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
  const [cur] = await db.select({ status: jobEstimates.status }).from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  const rolled = rollUpDecision(svcs.map((x) => x.s as ApprovalState), (cur?.status as EstimateStatus) ?? 'sent')
  await db.update(jobEstimates).set({ status: rolled, decidedAt: new Date(), updatedAt: new Date(), updatedBy: actor }).where(eq(jobEstimates.id, estimateId))
  await logJobEvent(orderId, 'estimate_decision', actor, `${serviceId.slice(0, 8)}=${state}`)
  return rolled
}

/** Convert: push APPROVED service titles into the Job's employee-facing services
 *  list (additive, de-duped) when ESTIMATE_CONVERT_SYNCS_SERVICES is on. Marks the
 *  estimate converted. Never creates a second Job / QB / AutoLeap record. */
export async function convertEstimate(estimateId: string, orderId: string, actor: string | null): Promise<{ synced: string[] }> {
  const db = getDb()
  const svcs = await db.select({ title: jobServices.title, approvalState: jobServices.approvalState }).from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
  let synced: string[] = []
  if (convertSyncsServices()) {
    const [order] = await db.select({ services: serviceOrders.services }).from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
    const existing = order?.services ?? []
    synced = approvedTitlesToSync(existing, svcs.map((s) => ({ title: s.title, approvalState: s.approvalState as ApprovalState })))
    if (synced.length > 0) {
      await db.update(serviceOrders).set({ services: [...existing, ...synced], updatedAt: new Date() }).where(eq(serviceOrders.id, orderId))
    }
  }
  await db.update(jobEstimates).set({ status: 'converted', convertedAt: new Date(), updatedAt: new Date(), updatedBy: actor }).where(eq(jobEstimates.id, estimateId))
  await logJobEvent(orderId, 'estimate_converted', actor, synced.length ? `approved → work: ${synced.join(', ')}` : 'converted')
  return { synced }
}
