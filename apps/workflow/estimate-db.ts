/**
 * Phase 3 estimate repository. Manager-gating is enforced at the API layer.
 * No QuickBooks/AutoLeap writes. Totals are recomputed by the pure engine and
 * cached on job_estimates after every mutation.
 */
import { getDb } from '@/platform/db'
import { eq, ne, and, asc, inArray } from 'drizzle-orm'
import { jobEstimates, jobServices, jobLineItems, serviceOrders, serviceOrderEvents } from './schema'
import {
  computeTotals, rollUpDecision, defaultTaxForType, defaultTaxBps, approvedTitlesToSync, convertSyncsServices,
  type LineType, type ApprovalState, type EstimateStatus, type TaxCategory,
} from './estimate'
import { computeFees, eligibleBasisCents, reconcilePlan, explicitPretaxTotals, type FeeCode } from './fees'
import { getBusinessConfig } from '@/apps/settings/db'

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
  // Seed the new estimate's tax rate from the configurable default_tax_bps setting
  // (falls back to env/825). Each estimate keeps its own overridable rate.
  const cfg = await getBusinessConfig().catch(() => null)
  const taxRateBps = cfg?.defaultTaxBps ?? defaultTaxBps()
  const [row] = await db.insert(jobEstimates).values({ serviceOrderId: orderId, taxRateBps, status: 'draft', createdBy: actor, updatedBy: actor }).returning()
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

/** All line items under an estimate (across its services). */
async function loadEstimateLines(estimateId: string) {
  const db = getDb()
  const svcs = await db.select({ id: jobServices.id }).from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
  const ids = svcs.map((s) => s.id)
  const lines = ids.length ? await db.select().from(jobLineItems).where(inArray(jobLineItems.jobServiceId, ids)) : []
  return lines
}

/** Find (or lazily create exactly one) system "Fees & Charges" service for the estimate.
 *  The partial unique index job_services_system_uniq guarantees only one can exist. */
async function getOrCreateFeeService(estimateId: string): Promise<string> {
  const db = getDb()
  const find = () => db.select({ id: jobServices.id }).from(jobServices)
    .where(and(eq(jobServices.jobEstimateId, estimateId), eq(jobServices.source, 'system'))).limit(1)
  const [existing] = await find()
  if (existing) return existing.id
  try {
    const [row] = await db.insert(jobServices).values({ jobEstimateId: estimateId, title: 'Fees & Charges', source: 'system', sortOrder: 9999 }).returning()
    return row.id
  } catch {
    const [again] = await find()   // lost a race to the unique index — reuse the winner
    return again.id
  }
}

/**
 * Reconcile generated fee lines (shop supplies / card processing) for an estimate.
 * Idempotent: computes the desired fees from the eligible pre-tax basis + settings,
 * then updates/inserts/deletes so there is exactly ONE line per fee_code. Fee lines
 * are type='fee', non-taxable, taxCategory='review' (needs_tax_review until the CPA
 * confirms treatment). Never touches hand-entered (non-generated) lines.
 */
export async function reconcileFees(estimateId: string): Promise<void> {
  const db = getDb()
  const lines = await loadEstimateLines(estimateId)
  const cfg = await getBusinessConfig()
  const [est] = await db.select({ priceMode: jobEstimates.priceMode, explicitTotalCents: jobEstimates.explicitTotalCents })
    .from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  // Fee basis: for an explicit-price Job the manager's amount IS the work subtotal;
  // otherwise sum the real (non-generated) line items. Never both (no double-count).
  const basis = est?.priceMode === 'explicit_pretax' && est.explicitTotalCents != null
    ? est.explicitTotalCents
    : eligibleBasisCents(lines.map((l) => ({ priceCents: l.priceCents, qty: l.qty, generated: l.generated })))
  const desired = computeFees(basis, cfg)
  const existingFees = lines
    .filter((l) => l.generated && l.feeCode)
    .map((l) => ({ id: l.id, feeCode: l.feeCode as FeeCode, priceCents: l.priceCents, name: l.name }))
  const plan = reconcilePlan(existingFees, desired)

  if (plan.toDelete.length) await db.delete(jobLineItems).where(inArray(jobLineItems.id, plan.toDelete))
  for (const u of plan.toUpdate) {
    await db.update(jobLineItems).set({ name: u.name, priceCents: u.priceCents }).where(eq(jobLineItems.id, u.id))
  }
  if (plan.toInsert.length) {
    const feeServiceId = await getOrCreateFeeService(estimateId)
    for (const [i, d] of plan.toInsert.entries()) {
      await db.insert(jobLineItems).values({
        jobServiceId: feeServiceId, type: 'fee', name: d.name, qty: '1', unit: 'each',
        costCents: 0, priceCents: d.priceCents, taxable: false, taxCategory: 'review',
        generated: true, feeCode: d.feeCode, sortOrder: 9000 + i,
      })
    }
  }
}

/** Recompute generated fees, then cached totals — respecting price_mode. */
export async function recomputeEstimate(estimateId: string): Promise<void> {
  await reconcileFees(estimateId)   // fee lines are upserted BEFORE totals are summed
  const db = getDb()
  const [est] = await db.select({
    rate: jobEstimates.taxRateBps, discount: jobEstimates.discountCents,
    priceMode: jobEstimates.priceMode, explicitTotalCents: jobEstimates.explicitTotalCents,
    taxCategory: jobEstimates.explicitTaxCategory,
  }).from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)

  let t
  if (est?.priceMode === 'explicit_pretax' && est.explicitTotalCents != null) {
    // Manager's amount is the authoritative work subtotal; fees/tax computed on top.
    // No per-service line prices are fabricated (services remain job_services only).
    const cfg = await getBusinessConfig()
    t = explicitPretaxTotals(est.explicitTotalCents, cfg, est.rate ?? defaultTaxBps(), est.taxCategory ?? 'review')
  } else {
    // Itemized (today's behavior): totals from the real line items.
    const lines = await loadEstimateLines(estimateId)
    t = computeTotals(lines.map((l) => ({ priceCents: l.priceCents, qty: l.qty, taxable: l.taxable, taxCategory: l.taxCategory })), est?.rate ?? defaultTaxBps(), est?.discount ?? 0)
  }

  await db.update(jobEstimates).set({
    taxableSubtotalCents: t.taxableSubtotalCents, nontaxableSubtotalCents: t.nontaxableSubtotalCents,
    taxCents: t.taxCents, totalCents: t.totalCents, needsTaxReview: t.needsTaxReview, updatedAt: new Date(),
  }).where(eq(jobEstimates.id, estimateId))
}

/** Store an internal note/instruction on the estimate (manager/commercial layer). */
export async function setInternalNote(estimateId: string, note: string): Promise<void> {
  await getDb().update(jobEstimates).set({ internalNotes: note.slice(0, 500), updatedAt: new Date() }).where(eq(jobEstimates.id, estimateId))
}

/** Set the manager's authoritative pre-fee/pre-tax work price (explicit_pretax mode). */
export async function setExplicitPrice(estimateId: string, workPriceCents: number, actor: string | null): Promise<void> {
  await getDb().update(jobEstimates).set({
    priceMode: 'explicit_pretax', explicitTotalCents: Math.max(0, Math.round(workPriceCents)),
    pricingSetBy: actor, pricingSetAt: new Date(), updatedAt: new Date(),
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
  // System fee service is excluded from the approval roll-up (fees aren't approvable work).
  const svcs = await db.select({ s: jobServices.approvalState }).from(jobServices).where(and(eq(jobServices.jobEstimateId, estimateId), ne(jobServices.source, 'system')))
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
  const svcs = await db.select({ title: jobServices.title, approvalState: jobServices.approvalState }).from(jobServices).where(and(eq(jobServices.jobEstimateId, estimateId), ne(jobServices.source, 'system')))
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
