/**
 * Phase 3 estimate repository. Manager-gating is enforced at the API layer.
 * No QuickBooks/AutoLeap writes. Totals are recomputed by the pure engine and
 * cached on job_estimates after every mutation.
 */
import { getDb } from '@/platform/db'
import { eq, ne, and, asc, inArray } from 'drizzle-orm'
import { jobEstimates, jobServices, jobLineItems, serviceOrders, serviceOrderEvents } from './schema'
import {
  computeTotals, rollUpDecision, defaultTaxForType, defaultTaxBps, approvedTitlesToSync, convertSyncsServices, lineAmountCents,
  type LineType, type ApprovalState, type EstimateStatus, type TaxCategory,
} from './estimate'
import { computeFees, eligibleBasisCents, reconcilePlan, explicitPretaxTotals, effectiveFeeConfig, isDealerOrder, FEE_TAX_CATEGORY, type FeeCode } from './fees'
import { allocateProportional } from './allocate'
import { getBusinessConfig } from '@/apps/settings/db'
import { suggestedPricesForTitles } from '@/apps/quick-entry/db'

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
  // Retail estimates are detailing by default → non-taxable, no tax-review clutter.
  // Mechanical/parts/collision would set a taxable category later (P-D+).
  const [row] = await db.insert(jobEstimates).values({ serviceOrderId: orderId, taxRateBps, explicitTaxCategory: 'detailing', status: 'draft', createdBy: actor, updatedBy: actor }).returning()
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

/** Estimate + its Job's billing context (source/type for retail-vs-dealer + waivers). */
async function loadEstimateContext(estimateId: string) {
  const db = getDb()
  const [row] = await db.select({
    priceMode: jobEstimates.priceMode, explicitTotalCents: jobEstimates.explicitTotalCents,
    taxCategory: jobEstimates.explicitTaxCategory, rate: jobEstimates.taxRateBps, discount: jobEstimates.discountCents,
    waiveShopSupplies: jobEstimates.waiveShopSupplies, waiveCardFee: jobEstimates.waiveCardFee, taxExempt: jobEstimates.taxExempt,
    source: serviceOrders.source, serviceType: serviceOrders.serviceType,
  }).from(jobEstimates).innerJoin(serviceOrders, eq(serviceOrders.id, jobEstimates.serviceOrderId))
    .where(eq(jobEstimates.id, estimateId)).limit(1)
  return row
}

/**
 * Reconcile generated fee lines (shop supplies / payment charge) for an estimate.
 * Idempotent: exactly ONE line per fee_code. Uses the EFFECTIVE config — dealer Jobs get
 * no retail charges, and per-Job waivers remove a charge. Fee lines are type='fee',
 * non-taxable, taxCategory='fee' (retail detailing is confirmed non-taxable — no review
 * clutter). Never touches hand-entered (non-generated) lines.
 */
export async function reconcileFees(estimateId: string): Promise<void> {
  const db = getDb()
  const ctx = await loadEstimateContext(estimateId)
  const lines = await loadEstimateLines(estimateId)
  const baseCfg = await getBusinessConfig()
  const cfg = effectiveFeeConfig(baseCfg, {
    isDealer: ctx ? isDealerOrder(ctx) : false,
    waiveShopSupplies: ctx?.waiveShopSupplies, waivePayment: ctx?.waiveCardFee,
  })
  const basis = ctx?.priceMode === 'explicit_pretax' && ctx.explicitTotalCents != null
    ? ctx.explicitTotalCents
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
        costCents: 0, priceCents: d.priceCents, taxable: false, taxCategory: FEE_TAX_CATEGORY,
        generated: true, feeCode: d.feeCode, sortOrder: 9000 + i,
      })
    }
  }
}

/** Recompute generated fees, then cached totals — respecting price_mode, dealer gating,
 *  per-Job waivers, and tax treatment (dealer / tax-exempt / non-taxable detailing → $0). */
export async function recomputeEstimate(estimateId: string): Promise<void> {
  await reconcileFees(estimateId)   // fee lines are upserted BEFORE totals are summed
  const db = getDb()
  const ctx = await loadEstimateContext(estimateId)

  let t
  if (ctx?.priceMode === 'explicit_pretax' && ctx.explicitTotalCents != null) {
    const isDealer = isDealerOrder(ctx)
    const cfg = effectiveFeeConfig(await getBusinessConfig(), { isDealer, waiveShopSupplies: ctx.waiveShopSupplies, waivePayment: ctx.waiveCardFee })
    // Dealer Jobs and admin tax-exempt overrides carry no tax; non-taxable categories
    // (detailing) also resolve to $0 inside explicitPretaxTotals.
    const effRate = isDealer || ctx.taxExempt ? 0 : (ctx.rate ?? defaultTaxBps())
    t = explicitPretaxTotals(ctx.explicitTotalCents, cfg, effRate, ctx.taxCategory ?? 'detailing')
  } else {
    const lines = await loadEstimateLines(estimateId)
    t = computeTotals(lines.map((l) => ({ priceCents: l.priceCents, qty: l.qty, taxable: l.taxable, taxCategory: l.taxCategory })), ctx?.rate ?? defaultTaxBps(), ctx?.discount ?? 0)
  }

  await db.update(jobEstimates).set({
    taxableSubtotalCents: t.taxableSubtotalCents, nontaxableSubtotalCents: t.nontaxableSubtotalCents,
    taxCents: t.taxCents, totalCents: t.totalCents, needsTaxReview: t.needsTaxReview, updatedAt: new Date(),
  }).where(eq(jobEstimates.id, estimateId))
}

/** Set one per-Job charge waiver (Invoice Draft controls). Caller enforces permissions.
 *  Recompute is done by the caller so the change flows through the single engine. */
export async function setEstimateWaiver(estimateId: string, field: 'shop_supplies' | 'payment' | 'tax_exempt', value: boolean): Promise<void> {
  const patch = field === 'shop_supplies' ? { waiveShopSupplies: value }
    : field === 'payment' ? { waiveCardFee: value }
    : { taxExempt: value }
  await getDb().update(jobEstimates).set({ ...patch, updatedAt: new Date() }).where(eq(jobEstimates.id, estimateId))
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

// ── Simplified mobile Estimate: one visible service = one editable price ──────────
// A service's price is carried by a single non-generated line (type 'labor', non-taxable
// detailing → tax $0). The manager never sees line types/cost/tax; they see title + price.
// Two price modes coexist over ONE record: explicit_pretax (flat Work Total, authoritative)
// and itemized (sum of these price lines). We never itemize a flat Job just by viewing it.
const DETAIL_LINE = { type: 'labor' as LineType, qty: 1, unit: 'each', taxable: false, taxCategory: 'detailing' as TaxCategory }

/** Non-system services for an estimate, in display order. */
async function listUserServices(estimateId: string): Promise<JobServiceRow[]> {
  return getDb().select().from(jobServices)
    .where(and(eq(jobServices.jobEstimateId, estimateId), ne(jobServices.source, 'system')))
    .orderBy(asc(jobServices.sortOrder), asc(jobServices.createdAt))
}
/** The single non-generated price line under a service (or null). */
async function getServicePriceLine(serviceId: string): Promise<JobLineRow | null> {
  const rows = await getDb().select().from(jobLineItems)
    .where(and(eq(jobLineItems.jobServiceId, serviceId), eq(jobLineItems.generated, false))).limit(1)
  return rows[0] ?? null
}
/** Upsert a service's single price line to an exact amount (qty 1, non-taxable detailing). */
async function upsertServicePrice(service: JobServiceRow, cents: number): Promise<void> {
  const existing = await getServicePriceLine(service.id)
  const price = Math.max(0, Math.round(cents))
  if (existing) await updateLine(existing.id, { priceCents: price, qty: 1 })
  else await addLine(service.id, { name: service.title, priceCents: price, ...DETAIL_LINE })
}
/** Flip the estimate to itemized mode (lines become authoritative; flat total dropped). */
async function setItemizedMode(estimateId: string): Promise<void> {
  await getDb().update(jobEstimates).set({ priceMode: 'itemized', explicitTotalCents: null, updatedAt: new Date() }).where(eq(jobEstimates.id, estimateId))
}

/** Convert a flat (explicit_pretax) Job into itemized by allocating its Work Total across
 *  services (weighted by catalog suggestion; even split if none). Basis-preserving. */
async function itemizeFromFlat(estimateId: string, actor: string | null): Promise<void> {
  void actor
  const [est] = await getDb().select().from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  const total = est?.explicitTotalCents ?? 0
  const services = await listUserServices(estimateId)
  if (services.length === 0) { await setItemizedMode(estimateId); return }
  const sugg = await suggestedPricesForTitles(services.map((s) => s.title))
  const weights = services.map((s) => sugg[s.title.trim().toLowerCase()] ?? 0)
  const alloc = allocateProportional(total, weights)
  for (let i = 0; i < services.length; i++) await upsertServicePrice(services[i], alloc[i])
  await setItemizedMode(estimateId)
}

/** Seed suggested prices for a TRULY fresh Job (itemized, no flat total, zero saved service
 *  prices). Never overwrites a saved price; once the manager has priced anything, no re-seed. */
export async function seedSuggestedPrices(estimateId: string): Promise<void> {
  const [est] = await getDb().select().from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  if (!est || est.priceMode !== 'itemized' || est.explicitTotalCents != null) return
  const services = await listUserServices(estimateId)
  if (services.length === 0) return
  for (const s of services) if (await getServicePriceLine(s.id)) return   // already engaged → stop
  const sugg = await suggestedPricesForTitles(services.map((s) => s.title))
  for (const s of services) {
    const p = sugg[s.title.trim().toLowerCase()]
    if (p != null) await addLine(s.id, { name: s.title, priceCents: p, ...DETAIL_LINE })
  }
}

/** Explicitly break a flat Job into per-service prices at its current Work Total. */
export async function itemizeEstimate(estimateId: string, actor: string | null): Promise<void> {
  await itemizeFromFlat(estimateId, actor)
  await recomputeEstimate(estimateId)
}

/** Set ONE service's price. Editing an individual price is the trigger that itemizes a
 *  flat Job (never on mere viewing). Recomputes fees/tax through the single engine. */
export async function setServicePrice(estimateId: string, serviceId: string, cents: number, actor: string | null): Promise<void> {
  const [est] = await getDb().select().from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  if (est?.priceMode === 'explicit_pretax' && est.explicitTotalCents != null) await itemizeFromFlat(estimateId, actor)
  const [svc] = await getDb().select().from(jobServices).where(eq(jobServices.id, serviceId)).limit(1)
  if (svc) await upsertServicePrice(svc, cents)
  await setItemizedMode(estimateId)
  await recomputeEstimate(estimateId)
}

/** Set the authoritative Work Total. Flat Job → stays flat (explicit_pretax). Itemized Job
 *  with lines → proportionally reallocate so the visible prices sum EXACTLY to the total. */
export async function setWorkTotal(estimateId: string, cents: number, actor: string | null): Promise<void> {
  const [est] = await getDb().select().from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  const services = await listUserServices(estimateId)
  const lines: { service: JobServiceRow; line: JobLineRow }[] = []
  for (const s of services) { const l = await getServicePriceLine(s.id); if (l) lines.push({ service: s, line: l }) }
  if (est?.priceMode === 'itemized' && lines.length > 0) {
    const weights = lines.map(({ line }) => lineAmountCents(line.priceCents, line.qty))
    const alloc = allocateProportional(cents, weights)
    for (let i = 0; i < lines.length; i++) await updateLine(lines[i].line.id, { priceCents: Math.max(0, alloc[i]), qty: 1 })
    await setItemizedMode(estimateId)
  } else {
    await setExplicitPrice(estimateId, cents, actor)   // flat stays flat / fresh-no-lines becomes flat
  }
  await recomputeEstimate(estimateId)
}

/** A clean view for the mobile Estimate page — title + price per service, plus the one
 *  authoritative Work Total. Hides line types / cost / tax / approval entirely. */
export interface EstimateServiceView { id: string; title: string; priceCents: number | null; suggestedCents: number | null }
export interface EstimateView { exists: boolean; flat: boolean; workTotalCents: number; services: EstimateServiceView[] }

export async function getEstimateView(orderId: string): Promise<EstimateView> {
  const full = await getFullEstimate(orderId)
  if (!full) return { exists: false, flat: false, workTotalCents: 0, services: [] }
  const est = full.estimate
  const services = full.services.filter((s) => s.source !== 'system')
  const sugg = await suggestedPricesForTitles(services.map((s) => s.title))
  const views: EstimateServiceView[] = services.map((s) => {
    const line = s.lines.find((l) => !l.generated)
    return {
      id: s.id, title: s.title,
      priceCents: line ? lineAmountCents(line.priceCents, line.qty) : null,
      suggestedCents: sugg[s.title.trim().toLowerCase()] ?? null,
    }
  })
  const flat = est.priceMode === 'explicit_pretax' && est.explicitTotalCents != null
  const eligible = views.reduce((sum, v) => sum + (v.priceCents ?? 0), 0)
  return { exists: true, flat, workTotalCents: flat ? est.explicitTotalCents! : eligible, services: views }
}

/** Page entry: ensure the estimate exists, mirror the Job's services, seed suggestions for a
 *  truly fresh Job, recompute, and return the view. Idempotent; safe to call on every open. */
export async function prepareEstimateView(orderId: string, actor: string | null): Promise<EstimateView> {
  const est = await getOrCreateEstimate(orderId, actor)
  await promoteTextServices(est.id, orderId)
  await seedSuggestedPrices(est.id)
  await recomputeEstimate(est.id)
  return getEstimateView(orderId)
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

/** If a retail QB invoice is linked to this Job, flag "QuickBooks sync needed" (surfaced in
 *  the Invoice Draft). Used after edits that affect the invoice; retail QB update isn't built
 *  yet, so this prevents Pitt Stop and QuickBooks silently diverging. Returns true if flagged. */
export async function flagQbSyncNeededIfInvoiced(orderId: string, reason: string): Promise<boolean> {
  const est = await getEstimateRow(orderId)
  if (!est?.qbInvoiceId) return false
  await getDb().update(jobEstimates).set({ qbSyncError: `QuickBooks sync needed — ${reason}.`, updatedAt: new Date() }).where(eq(jobEstimates.id, est.id))
  return true
}

/**
 * Remove a service from a Job, keeping the unified structures in sync (manager/admin only —
 * enforced at the route). Removes it from service_orders.services AND the matching
 * job_services row (its job_line_items cascade), then recomputes: itemized Jobs drop that
 * line's price and the remaining lines determine the new Work Total; flat (explicit_pretax)
 * Jobs keep their manager-chosen total. If a retail QB invoice is linked, flags
 * "QuickBooks sync needed" (never silently diverges). Audited with before/after + impact.
 */
export async function removeServiceFromJob(orderId: string, serviceName: string, actor: string | null): Promise<{ removed: boolean; services: string[]; pricingImpactCents: number | null; qbSyncNeeded: boolean }> {
  const db = getDb()
  const norm = (s: string) => s.trim().toLowerCase()
  const target = norm(serviceName)
  const [cur] = await db.select({ services: serviceOrders.services }).from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  const existing = cur?.services ?? []
  const next = existing.filter((s) => norm(s) !== target)
  if (next.length === existing.length) return { removed: false, services: existing, pricingImpactCents: null, qbSyncNeeded: false }

  await db.update(serviceOrders).set({ services: next, updatedAt: new Date() }).where(eq(serviceOrders.id, orderId))

  let pricingImpactCents: number | null = null
  let qbSyncNeeded = false
  const est = await getEstimateRow(orderId)
  if (est) {
    const svcs = await db.select().from(jobServices).where(and(eq(jobServices.jobEstimateId, est.id), ne(jobServices.source, 'system')))
    for (const s of svcs.filter((x) => norm(x.title) === target)) {
      const lines = await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, s.id))
      const priced = lines.filter((l) => !l.generated).reduce((sum, l) => sum + lineAmountCents(l.priceCents, l.qty), 0)
      if (priced > 0) pricingImpactCents = (pricingImpactCents ?? 0) + priced
      await db.delete(jobServices).where(eq(jobServices.id, s.id))   // job_line_items cascade
    }
    await recomputeEstimate(est.id)   // itemized → remaining lines set the total; flat → unchanged
    if (est.qbInvoiceId) {
      await db.update(jobEstimates).set({ qbSyncError: 'QuickBooks sync needed — a service was removed after the invoice was created.', updatedAt: new Date() }).where(eq(jobEstimates.id, est.id))
      qbSyncNeeded = true
    }
  }

  await logJobEvent(orderId, 'service_removed', actor, JSON.stringify({ removed: serviceName, before: existing, after: next, pricingImpactCents, qbSyncNeeded }))
  return { removed: true, services: next, pricingImpactCents, qbSyncNeeded }
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
