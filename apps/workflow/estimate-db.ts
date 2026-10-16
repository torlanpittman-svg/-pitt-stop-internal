/**
 * Phase 3 estimate repository. Manager-gating is enforced at the API layer.
 * No QuickBooks/AutoLeap writes. Totals are recomputed by the pure engine and
 * cached on job_estimates after every mutation.
 */
import { getDb } from '@/platform/db'
import { eq, ne, and, asc, inArray, sql } from 'drizzle-orm'
import { jobEstimates, jobServices, jobLineItems, serviceOrders, serviceOrderEvents } from './schema'
import {
  computeTotals, rollUpDecision, defaultTaxForType, defaultTaxBps, approvedTitlesToSync, convertSyncsServices, lineAmountCents,
  type LineType, type ApprovalState, type EstimateStatus, type TaxCategory,
} from './estimate'
import { computeFees, eligibleBasisCents, reconcilePlan, explicitPretaxTotals, effectiveFeeConfig, isDealerOrder, FEE_TAX_CATEGORY, type FeeCode } from './fees'
import { getBusinessConfig } from '@/apps/settings/db'
import { suggestedPricesForTitles } from '@/apps/quick-entry/db'
import { resolveCatalogId, resolveCatalogIds, normalizeServiceKey } from '@/apps/quick-entry/catalog-identity'
import { serviceCatalog } from '@/apps/quick-entry/schema'
import { jobParts } from '@/apps/parts/schema'
import { eligibleCatalogChoice, catalogDescriptionSnapshot, canonicalDescription } from '@/apps/quick-entry/service-match-db'
import { composeLineDescription, partLineDescription, cleanDetail } from '@/apps/quickbooks/retail-format'
import { loadEstimateReview } from './estimate-review'
import { needsOdorChoice, type ReadinessIssue } from './estimate-readiness'
import type { LaborStatus } from '@/apps/parts/labor-review'

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

/**
 * Set the employee-confirmed EXPECTED Job value at intake (pre-fee/pre-tax). This is the operational
 * production value ANY employee may establish — it does NOT set explicit_total_cents, does NOT change
 * price_mode, and never touches fees/tax/QuickBooks (those stay manager-only). agreedMeta carries the
 * per-service audit. Production reads agreed_price_cents only when no manager price exists (precedence).
 */
export async function setAgreedPrice(estimateId: string, agreedPriceCents: number, meta: unknown, actor: string | null): Promise<void> {
  await getDb().update(jobEstimates).set({
    agreedPriceCents: Math.max(0, Math.round(agreedPriceCents)),
    agreedMeta: (meta ?? null) as never,
    updatedAt: new Date(),
  }).where(eq(jobEstimates.id, estimateId))
  void actor
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
  // A part's price is per unit with its own qty/cost — edited through the part editor, never here.
  if (service.kind === 'part') throw new Error('Edit a part’s price in the Parts section.')
  const existing = await getServicePriceLine(service.id)
  const price = Math.max(0, Math.round(cents))
  if (existing) await updateLine(existing.id, { priceCents: price, qty: 1 })
  else await addLine(service.id, { name: service.title, priceCents: price, ...DETAIL_LINE })
}
/**
 * Flip the estimate to itemized mode. By default the flat Work Total (explicit_total_cents) is
 * RETAINED as a labeled reference so an agreed amount is never silently dropped to $0/partial while
 * the per-service breakdown is still incomplete. Pass dropReference=true once every service is
 * priced (a complete breakdown is authoritative on its own and no longer needs the reference).
 */
async function setItemizedMode(estimateId: string, dropReference = false): Promise<void> {
  await getDb().update(jobEstimates).set({
    priceMode: 'itemized',
    ...(dropReference ? { explicitTotalCents: null } : {}),
    updatedAt: new Date(),
  }).where(eq(jobEstimates.id, estimateId))
}

/** Every user (non-system) service has a price line → a complete itemized breakdown. A line with
 *  an explicit $0 counts as PRICED (a free service); only a service with no line at all is unpriced. */
async function isItemizationComplete(estimateId: string): Promise<boolean> {
  const services = await listUserServices(estimateId)
  if (services.length === 0) return false
  for (const s of services) if (!(await getServicePriceLine(s.id))) return false
  return true
}

/** Sum of the per-service (non-generated) price lines. */
async function sumUserServiceLines(estimateId: string): Promise<number> {
  const services = await listUserServices(estimateId)
  let sum = 0
  for (const s of services) { const l = await getServicePriceLine(s.id); if (l) sum += lineAmountCents(l.priceCents, l.qty) }
  return sum
}

/**
 * Move to itemized mode after a per-service price edit. The retained flat amount (reference) is:
 *  - KEPT while any service is still unpriced (incomplete → shown as the agreed reference); and
 *  - KEPT when the breakdown is complete but its sum DIFFERS from the reference, so the manager is
 *    shown the difference and must accept the itemized total (see acceptItemizedTotal) — completing
 *    itemization never silently replaces the agreed amount with a different total; and
 *  - DROPPED only when complete and the itemized sum already equals the reference (nothing to
 *    reconcile), or when there was no reference to begin with.
 * Never fabricates or redistributes a price.
 */
async function syncItemizationState(estimateId: string): Promise<void> {
  if (!(await isItemizationComplete(estimateId))) { await setItemizedMode(estimateId, false); return }
  const [est] = await getDb().select({ ref: jobEstimates.explicitTotalCents }).from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  const ref = est?.ref ?? null
  const matches = ref == null || ref === (await sumUserServiceLines(estimateId))
  await setItemizedMode(estimateId, matches)   // drop the reference only when there is nothing to reconcile
}

/**
 * Switch a flat (explicit_pretax) Job to itemized mode.
 *
 * We intentionally do NOT fabricate a per-service split from the flat Work Total. The previous
 * behaviour allocated that total across services weighted by catalog suggestion — which silently
 * redistributed money: services with no catalog match got weight 0 and were ZEROED, and the whole
 * total was lumped onto the matched one(s). That is the reported "several line prices become $0 and
 * another shows $500–$600 by itself" corruption (the total stayed correct, so it looked fine at a
 * glance).
 *
 * Switching modes leaves each service unpriced for the manager to enter (catalog suggestions still
 * appear as tap-to-fill hints in the view). The flat amount is RETAINED as a reference
 * (explicit_total_cents) and surfaced clearly as "agreed reference" in the view/invoice while the
 * breakdown is incomplete — so we never silently replace an agreed amount with a $0/partial total.
 * The reference is dropped only once every service is priced. No money is ever moved between services.
 */
async function itemizeFromFlat(estimateId: string): Promise<void> {
  await setItemizedMode(estimateId)   // retain the flat amount as a reference (not complete yet)
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

/**
 * After a line's price was set/cleared OUTSIDE setServicePrice (a part's sell price): same rules as a
 * price edit — a priced line on a flat Job itemizes it (agreed amount kept as a reference, never a
 * fabricated split), then the reference is dropped only once complete and equal. Recomputes.
 */
export async function settlePricingAfterLineChange(estimateId: string, priced: boolean): Promise<void> {
  const [est] = await getDb().select().from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  const flat = est?.priceMode === 'explicit_pretax' && est.explicitTotalCents != null
  if (flat && priced) await itemizeFromFlat(estimateId)
  if (!flat || priced) await syncItemizationState(estimateId)
  await recomputeEstimate(estimateId)
}

/** Explicitly switch a flat Job to itemized so the manager can enter per-service prices. */
export async function itemizeEstimate(estimateId: string, actor: string | null): Promise<void> {
  void actor
  await itemizeFromFlat(estimateId)
  await recomputeEstimate(estimateId)
}

/**
 * Manager acknowledges that a COMPLETE itemized breakdown is the total, accepting any difference from
 * the agreed reference. Drops the retained reference (so the itemized sum stands on its own). No-op
 * while still incomplete — the agreed amount is never dropped until every service is priced. Never
 * changes a service price.
 */
export async function acceptItemizedTotal(estimateId: string, actor: string | null): Promise<void> {
  void actor
  if (!(await isItemizationComplete(estimateId))) return
  await getDb().update(jobEstimates).set({ explicitTotalCents: null, updatedAt: new Date() }).where(eq(jobEstimates.id, estimateId))
  await recomputeEstimate(estimateId)
}

/** Set ONE service's price. Editing an individual price is the trigger that itemizes a
 *  flat Job (never on mere viewing). Recomputes fees/tax through the single engine. */
export async function setServicePrice(estimateId: string, serviceId: string, cents: number, actor: string | null): Promise<void> {
  const [est] = await getDb().select().from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  // Editing one price on a flat Job switches it to itemized WITHOUT fabricating the other
  // services' prices (they stay blank for the manager to enter) — never a catalog-weighted split.
  if (est?.priceMode === 'explicit_pretax' && est.explicitTotalCents != null) await itemizeFromFlat(estimateId)
  void actor
  const [svc] = await getDb().select().from(jobServices).where(eq(jobServices.id, serviceId)).limit(1)
  if (svc) await upsertServicePrice(svc, cents)
  await syncItemizationState(estimateId)   // itemized; drop the flat reference only once complete
  await recomputeEstimate(estimateId)
}

/**
 * Set the authoritative Work Total.
 *  - Flat Job, or a fresh itemized Job with NO priced services yet → store it as the flat
 *    explicit_pretax total (a quick single-number price).
 *  - Itemized Job that ALREADY has per-service prices → the Work Total is DERIVED from those
 *    prices; it is not separately authoritative. We do NOT reallocate the entered number across
 *    services. The old behaviour proportionally scaled every line (and, when only some services
 *    were priced, lumped the whole total onto those few) — a silent redistribution of money the
 *    manager never typed. To change the total now, edit the individual service prices; the UI
 *    shows the itemized Work Total read-only for exactly this reason.
 */
export async function setWorkTotal(estimateId: string, cents: number, actor: string | null): Promise<void> {
  const [est] = await getDb().select().from(jobEstimates).where(eq(jobEstimates.id, estimateId)).limit(1)
  const services = await listUserServices(estimateId)
  let hasPricedLine = false
  for (const s of services) {
    const l = await getServicePriceLine(s.id)
    if (l && lineAmountCents(l.priceCents, l.qty) > 0) { hasPricedLine = true; break }
  }
  if (est?.priceMode === 'itemized' && hasPricedLine) {
    // Derived total — ignore the override so per-service prices are never silently redistributed.
    await recomputeEstimate(estimateId)
    return
  }
  await setExplicitPrice(estimateId, cents, actor)   // flat, or fresh-no-lines → flat single price
  await recomputeEstimate(estimateId)
}

/** A clean view for the mobile Estimate page — title + price per service, plus the one
 *  authoritative Work Total. Hides line types / cost / tax / approval entirely. */
export interface EstimateServiceView {
  id: string; title: string; priceCents: number | null; suggestedCents: number | null
  /** Selected catalog identity (null = custom or not matched yet). */
  catalogId?: string | null
  catalogName?: string | null
  /** Exactly what the invoice line will say (canonical description + detail, or the custom name). */
  description?: string
  detail?: string | null
  matchMethod?: string | null
  /** 'matched' | 'custom' (confirmed one-off) | 'unmatched' (legacy, no identity) | 'choose' (odor wording needs a treatment) */
  matchState?: 'matched' | 'custom' | 'unmatched' | 'choose'
  /** False → this service bills under the generic Labor item until a manager maps its QuickBooks item. */
  qbMapped?: boolean
  role?: string | null
  entryText?: string | null
  overlapAcknowledged?: boolean
}
export interface EstimatePartView {
  id: string; serviceId: string | null; description: string; fitment: string | null; partNumber: string | null; supplier: string | null
  quantity: number; unitCostCents: number | null; sellPriceCents: number | null; lineCents: number | null
  supply: 'shop' | 'customer'; laborStatus: LaborStatus; laborServiceId: string | null; laborNote: string | null
  /** Exactly what the invoice line will say. */
  invoiceText: string
}
export interface EstimateReviewView { ready: boolean; issues: ReadinessIssue[] }
export interface EstimateView {
  exists: boolean
  flat: boolean
  workTotalCents: number
  services: EstimateServiceView[]
  /** Itemized breakdown started but not every service is priced yet. When true the itemized
   *  workTotalCents is only a partial running sum — not the agreed amount. */
  incomplete: boolean
  /** The agreed flat amount retained as a reference while itemizing is incomplete (null if the Job
   *  never had a flat price, or once the breakdown is complete). Shown clearly as "agreed reference". */
  referenceCents: number | null
  parts?: EstimatePartView[]
  review?: EstimateReviewView
}

export async function getEstimateView(orderId: string): Promise<EstimateView> {
  const full = await getFullEstimate(orderId)
  if (!full) return { exists: false, flat: false, workTotalCents: 0, services: [], incomplete: false, referenceCents: null, parts: [], review: { ready: true, issues: [] } }
  const est = full.estimate
  const userServices = full.services.filter((s) => s.source !== 'system')
  const services = userServices.filter((s) => s.kind !== 'part')
  const partServices = userServices.filter((s) => s.kind === 'part')
  const db = getDb()
  const catIds = [...new Set(userServices.map((s) => s.catalogId).filter((x): x is string => !!x))]
  const [sugg, cats, review] = await Promise.all([
    suggestedPricesForTitles(services.map((s) => s.title)),
    catIds.length ? db.select().from(serviceCatalog).where(inArray(serviceCatalog.id, catIds)) : Promise.resolve([] as (typeof serviceCatalog.$inferSelect)[]),
    loadEstimateReview(orderId),
  ])
  const catById = new Map(cats.map((c) => [c.id, c]))
  const reviewSvc = new Map(review.services.map((s) => [s.id, s]))
  const views: EstimateServiceView[] = services.map((s) => {
    const line = s.lines.find((l) => !l.generated)
    const c = s.catalogId ? catById.get(s.catalogId) : undefined
    const base = c ? (s.catalogDescription ?? canonicalDescription(c)) : s.title
    const rs = reviewSvc.get(s.id)
    const matchState: EstimateServiceView['matchState'] = rs && needsOdorChoice(rs) ? 'choose' : c ? 'matched' : s.matchMethod === 'custom' ? 'custom' : 'unmatched'
    return {
      id: s.id, title: s.title,
      priceCents: line ? lineAmountCents(line.priceCents, line.qty) : null,
      suggestedCents: sugg[s.title.trim().toLowerCase()] ?? null,
      catalogId: s.catalogId, catalogName: c?.name ?? null,
      description: composeLineDescription(base, s.detail), detail: s.detail, matchMethod: s.matchMethod, matchState,
      qbMapped: c ? (c.archivedAt == null && c.qbSyncEnabled && c.qbItemStatus === 'existing' && !!c.qbItemRef) : false,
      role: c?.serviceRole ?? null, entryText: s.entryText, overlapAcknowledged: s.overlapAckAt != null,
    }
  })
  // Parts (special-order + customer-supplied) with their effective labor review.
  const partRows = await db.select().from(jobParts).where(and(eq(jobParts.serviceOrderId, orderId), ne(jobParts.status, 'cancelled'))).orderBy(asc(jobParts.createdAt))
  const reviewPart = new Map(review.parts.map((p) => [p.id, p]))
  const partSvcById = new Map(partServices.map((s) => [s.id, s]))
  const parts: EstimatePartView[] = partRows.map((p) => {
    const svc = p.jobServiceId ? partSvcById.get(p.jobServiceId) : undefined
    const line = svc?.lines.find((l) => !l.generated)
    return {
      id: p.id, serviceId: svc?.id ?? null, description: p.description, fitment: p.fitment, partNumber: p.partNumber, supplier: p.supplier,
      quantity: Number(p.quantity), unitCostCents: p.unitCostCents, sellPriceCents: line ? line.priceCents : null,
      lineCents: line ? lineAmountCents(line.priceCents, line.qty) : null,
      supply: p.supply === 'customer' ? 'customer' : 'shop',
      laborStatus: (reviewPart.get(p.id)?.laborStatus ?? 'needs_review') as LaborStatus,
      laborServiceId: p.laborServiceId, laborNote: p.laborNote,
      invoiceText: line?.description || partLineDescription(p),
    }
  })
  const partLines = partServices.map((s) => s.lines.find((l) => !l.generated))
  const flat = est.priceMode === 'explicit_pretax' && est.explicitTotalCents != null
  const eligible = views.reduce((sum, v) => sum + (v.priceCents ?? 0), 0) + partLines.reduce((sum, l) => sum + (l ? lineAmountCents(l.priceCents, l.qty) : 0), 0)
  // Itemized but some service (or shop-supplied part) still unpriced → incomplete. Surface the retained
  // flat amount as a labeled reference so the UI never presents the partial sum as the agreed total.
  const incomplete = !flat && (views.length + partServices.length) > 0 && (views.some((v) => v.priceCents == null) || partLines.some((l) => !l))
  const referenceCents = !flat ? (est.explicitTotalCents ?? null) : null
  return {
    exists: true, flat, workTotalCents: flat ? est.explicitTotalCents! : eligible, services: views, incomplete, referenceCents,
    parts, review: { ready: review.readiness.ready, issues: review.readiness.issues },
  }
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

/** Seed job_services from the Job's employee-facing text services (idempotent). Each new row is
 *  stamped with its stable catalog identity (same name/alias policy as the QB payload) so its
 *  invoice item/description survives a later label edit. */
export async function promoteTextServices(estimateId: string, orderId: string, hints?: ReadonlyMap<string, string>): Promise<number> {
  const db = getDb()
  const [order] = await db.select({ services: serviceOrders.services }).from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  const text = (order?.services ?? []).map((s) => s.trim()).filter(Boolean)
  if (text.length === 0) return 0
  const existing = await db.select({ title: jobServices.title }).from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))
  const have = new Set(existing.map((s) => s.title.trim().toLowerCase()))
  const toInsert = text.map((title, i) => ({ title, i })).filter(({ title }) => !have.has(title.toLowerCase()))
  if (toInsert.length === 0) return 0
  const catalogIds = await resolveCatalogIds(toInsert.map((t) => t.title))
  let n = 0
  for (const { title, i } of toInsert) {
    // An explicit catalog choice made at intake (a tapped shortcut) wins over label matching.
    const hinted = hints?.get(normalizeServiceKey(title))
    const choice = hinted ? await eligibleCatalogChoice(hinted) : null
    const catalogId = choice?.catalogId ?? catalogIds.get(normalizeServiceKey(title)) ?? null
    await db.insert(jobServices).values({
      jobEstimateId: estimateId, title, source: 'promoted', sortOrder: i, catalogId,
      matchMethod: choice ? 'shortcut' : catalogId ? 'legacy' : null,
      catalogDescription: await catalogDescriptionSnapshot(catalogId),
    })
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
      await reopenLaborCoveredBy(orderId, s.id, actor, 'covering labor was removed')
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

export type MatchMethod = 'exact' | 'alias' | 'rule' | 'suggestion' | 'shortcut' | 'manual' | 'custom' | 'legacy'
const MATCH_METHODS: readonly MatchMethod[] = ['exact', 'alias', 'rule', 'suggestion', 'shortcut', 'manual', 'custom', 'legacy']
export const toMatchMethod = (m: unknown, fallback: MatchMethod): MatchMethod => (MATCH_METHODS as readonly string[]).includes(String(m)) ? (m as MatchMethod) : fallback

export interface AddServiceOptions {
  /** The user's explicit catalog choice (validated: live retail catalog only). */
  catalogId?: string | null
  /** Explicit "no catalog match — custom service" confirmation (bills as Labor with this wording). */
  custom?: boolean
  detail?: string | null
  matchMethod?: MatchMethod
  entryText?: string | null
  actor?: string | null
  kind?: 'service' | 'part'
}

/**
 * Add a service row. With an explicit catalogId (picker / shortcut / confirmed suggestion) the
 * identity is exactly that item — matching never changes price, qty, or tax. `custom` records an
 * explicit one-off. With neither, the legacy name/alias resolver runs (unchanged behaviour for
 * older callers). The canonical description is snapshotted so later catalog edits affect only
 * future additions.
 */
/** Re-open the labor review of parts whose installation relied on this service (audited). */
export async function reopenLaborCoveredBy(orderId: string, serviceId: string, actor: string | null, reason: string): Promise<number> {
  const rows = await getDb().update(jobParts).set({ laborStatus: 'needs_review', laborServiceId: null, laborDecidedBy: actor, laborDecidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(jobParts.laborServiceId, serviceId), inArray(jobParts.laborStatus, ['labor_added', 'included']))).returning({ id: jobParts.id })
  for (const r of rows) await logJobEvent(orderId, 'part_labor_reopened', actor, JSON.stringify({ partId: r.id, serviceId, reason }))
  return rows.length
}

export async function addService(estimateId: string, title: string, opts: AddServiceOptions = {}): Promise<JobServiceRow> {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!clean) throw new Error('Enter a service name.')
  let catalogId: string | null = null
  let matchMethod: MatchMethod | null = null
  if (opts.kind === 'part') {
    matchMethod = null
  } else if (opts.catalogId) {
    const choice = await eligibleCatalogChoice(opts.catalogId)
    if (!choice) throw new Error('That service is not in the catalog. Pick another or add it as a custom service.')
    catalogId = choice.catalogId
    matchMethod = opts.matchMethod ?? 'manual'
  } else if (opts.custom) {
    matchMethod = 'custom'
  } else {
    catalogId = await resolveCatalogId(clean)   // stable catalog identity for the QB payload
    matchMethod = catalogId ? 'legacy' : null
  }
  const [row] = await getDb().insert(jobServices).values({
    jobEstimateId: estimateId, title: clean, source: 'manual', catalogId, kind: opts.kind ?? 'service',
    detail: cleanDetail(opts.detail), matchMethod, entryText: opts.entryText ? String(opts.entryText).slice(0, 300) : null,
    matchedBy: matchMethod ? opts.actor ?? null : null, matchedAt: matchMethod ? new Date() : null,
    catalogDescription: await catalogDescriptionSnapshot(catalogId),
  }).returning()
  return row
}

/** Load a non-system service that belongs to THIS order's estimate, or throw. */
async function ownService(orderId: string, serviceId: string): Promise<{ est: EstimateRow; service: JobServiceRow; services: JobServiceRow[] }> {
  const est = await getEstimateRow(orderId)
  const services = est ? await listUserServices(est.id) : []
  const service = services.find((s) => s.id === serviceId)
  if (!est || !service) throw new Error('That service is no longer on this estimate. Refresh to see the current list.')
  return { est, service, services }
}

/**
 * Correct a service's catalog identity (the "Change" action) — an explicit user decision, unlike a
 * label rename, so it MAY repoint the identity. Price line, qty, tax flags, and sort order are not
 * touched. Optionally retitles (when the title just mirrored the old match). If the identity
 * changes, any parts that relied on this line for installation re-open their labor review, and a
 * prior "keep alongside the package" acknowledgement is cleared. Audited (service_matched).
 */
export async function selectServiceMatch(orderId: string, serviceId: string, input: { catalogId?: string | null; custom?: boolean; detail?: string | null; title?: string | null; matchMethod?: MatchMethod }, actor: string | null): Promise<void> {
  const { est, service, services } = await ownService(orderId, serviceId)
  if (service.kind === 'part') throw new Error('Parts are edited in the Parts section.')
  let catalogId: string | null = null
  if (input.catalogId) {
    const choice = await eligibleCatalogChoice(input.catalogId)
    if (!choice) throw new Error('That service is not in the catalog. Pick another or add it as a custom service.')
    catalogId = choice.catalogId
  } else if (!input.custom) {
    throw new Error('Pick a service, or confirm it as a custom service.')
  }
  const method: MatchMethod = catalogId ? (input.matchMethod ?? 'manual') : 'custom'
  const title = input.title != null ? String(input.title).replace(/\s+/g, ' ').trim().slice(0, 200) : service.title
  if (!title) throw new Error('Enter a service name.')
  const norm = (x: string) => x.trim().toLowerCase()
  if (title !== service.title && services.some((s) => s.id !== serviceId && norm(s.title) === norm(title))) throw new Error('Another service on this estimate already has that name.')
  const detail = input.detail !== undefined ? cleanDetail(input.detail) : service.detail
  const identityChanged = (service.catalogId ?? null) !== catalogId
  const snapshot = identityChanged ? await catalogDescriptionSnapshot(catalogId) : service.catalogDescription
  await getDb().execute(sql`
    WITH svc AS (
      SELECT id, title, catalog_id FROM job_services WHERE id = ${serviceId}::uuid AND job_estimate_id = ${est.id}::uuid AND source <> 'system'
    ), upd AS (
      UPDATE job_services js SET catalog_id = ${catalogId}::uuid, match_method = ${method}, matched_by = ${actor}, matched_at = now(),
        detail = ${detail}, title = ${title}, catalog_description = ${snapshot},
        entry_text = COALESCE(entry_text, CASE WHEN svc.title <> ${title} THEN left(svc.title, 300) END),
        overlap_ack_by = CASE WHEN ${identityChanged}::boolean THEN NULL ELSE overlap_ack_by END,
        overlap_ack_at = CASE WHEN ${identityChanged}::boolean THEN NULL ELSE overlap_ack_at END,
        updated_at = now()
      FROM svc WHERE js.id = svc.id RETURNING js.id
    ), upd_line AS (
      UPDATE job_line_items l SET name = ${title} FROM svc
      WHERE l.job_service_id = svc.id AND l.generated = false AND l.name = svc.title AND svc.title <> ${title} RETURNING l.id
    ), upd_order AS (
      UPDATE service_orders so SET updated_at = now(), services = (
        SELECT jsonb_agg(CASE WHEN lower(trim(a.x)) = lower(trim(svc.title)) THEN to_jsonb(${title}::text) ELSE to_jsonb(a.x) END ORDER BY a.ord)
        FROM jsonb_array_elements_text(so.services) WITH ORDINALITY AS a(x, ord))
      FROM svc
      WHERE so.id = ${orderId}::uuid AND svc.title <> ${title} AND jsonb_typeof(so.services) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(so.services) AS b(x) WHERE lower(trim(b.x)) = lower(trim(svc.title)))
      RETURNING so.id
    ), reopen AS (
      UPDATE job_parts SET labor_status = 'needs_review', labor_service_id = NULL, labor_decided_by = ${actor}, labor_decided_at = now(), updated_at = now()
      WHERE labor_service_id IN (SELECT id FROM svc) AND ${identityChanged}::boolean AND labor_status IN ('labor_added', 'included')
      RETURNING id
    ), ev_reopen AS (
      INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
      SELECT ${orderId}::uuid, 'part_labor_reopened', ${actor}, json_build_object('partId', reopen.id, 'serviceId', ${serviceId}::text, 'reason', 'covering labor was changed')::text FROM reopen
      RETURNING id
    )
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
    SELECT ${orderId}::uuid, 'service_matched', ${actor},
      json_build_object('serviceId', svc.id, 'from', json_build_object('catalogId', svc.catalog_id, 'title', svc.title),
        'to', json_build_object('catalogId', ${catalogId}::uuid, 'title', ${title}::text, 'method', ${method}::text, 'detail', ${detail}::text))::text
    FROM svc, upd
  `)
}

/** Set/clear the job-specific detail ("passenger seat"). Identity, price, qty, tax untouched. Audited. */
export async function setServiceDetail(orderId: string, serviceId: string, rawDetail: unknown, actor: string | null): Promise<void> {
  const { service } = await ownService(orderId, serviceId)
  const detail = cleanDetail(rawDetail)
  if ((service.detail ?? null) === detail) return
  await getDb().update(jobServices).set({ detail, updatedAt: new Date() }).where(eq(jobServices.id, serviceId))
  await logJobEvent(orderId, 'service_detail', actor, JSON.stringify({ serviceId, from: service.detail, to: detail }))
}

/** Keep an Ozone/Air Duct line alongside Complete Odor Treatment ON PURPOSE (e.g. a second treatment). Audited. */
export async function acknowledgeOdorOverlap(orderId: string, serviceId: string, actor: string | null): Promise<void> {
  const { service } = await ownService(orderId, serviceId)
  await getDb().update(jobServices).set({ overlapAckBy: actor, overlapAckAt: new Date(), updatedAt: new Date() }).where(eq(jobServices.id, serviceId))
  await logJobEvent(orderId, 'odor_overlap_kept', actor, JSON.stringify({ serviceId, title: service.title }))
}
export async function updateService(id: string, patch: Partial<Pick<JobServiceRow, 'title' | 'technician' | 'notes' | 'approvalState' | 'sortOrder'>>): Promise<void> {
  const set: Record<string, unknown> = { ...patch, updatedAt: new Date() }
  // A title edit here is also a label change: capture catalog identity the same way renameService
  // does — from the EXISTING label first (so a known service keeps its item even if relabeled to
  // another name), else from the corrected label (so a typo can newly resolve). Never overwrites an
  // identity that is already set (COALESCE), so repeated edits can't repoint the QB item.
  if (patch.title !== undefined) {
    const title = String(patch.title).replace(/\s+/g, ' ').trim()
    set.title = title
    const [cur] = await getDb().select({ catalogId: jobServices.catalogId, title: jobServices.title }).from(jobServices).where(eq(jobServices.id, id)).limit(1)
    if (cur && cur.catalogId == null) {
      const resolved = (await resolveCatalogId(cur.title)) ?? (await resolveCatalogId(title))
      if (resolved) {
        set.catalogId = sql`COALESCE(${jobServices.catalogId}, ${resolved}::uuid)`
        set.catalogDescription = sql`COALESCE(${jobServices.catalogDescription}, ${await catalogDescriptionSnapshot(resolved)})`
      }
    }
  }
  await getDb().update(jobServices).set(set).where(eq(jobServices.id, id))
}
/**
 * Correct a service's estimate LABEL in place (typo fix) — same job_services row, so its price
 * line (qty, price, tax flags), approval, and sort order are untouched. The price line's name is
 * kept in step only when it still mirrors the old title, and the Job's employee-facing services
 * text is renamed too so promoteTextServices never re-adds the old spelling on reopen.
 *
 * The label is NOT the QuickBooks invoice text. A service carries a STABLE catalog_id identity so
 * the QB payload keeps the catalog's correct Product/Service item + canonical qb_description
 * regardless of the label. We CAPTURE that identity before renaming: an already-identified service
 * keeps its item (relabeling it — even to another catalog item's name — never repoints it), and a
 * previously-unmatched service resolves from the EXISTING label first, then from the corrected
 * label (so a genuine typo fix can newly match). COALESCE makes the write concurrency-safe: a
 * mapping already set (here or by a racing writer) is never overwritten. No QuickBooks call is made
 * on rename. One SQL statement → atomic.
 */
export async function renameService(orderId: string, serviceId: string, rawTitle: string, actor: string | null): Promise<void> {
  const title = String(rawTitle ?? '').replace(/\s+/g, ' ').trim()
  if (!title) throw new Error('Enter a service name.')
  if (title.length > 200) throw new Error('Service name must be 200 characters or fewer.')
  const db = getDb()
  const est = await getEstimateRow(orderId)
  const services = est ? await listUserServices(est.id) : []
  const service = services.find((s) => s.id === serviceId)
  if (!service) throw new Error('Service does not belong to this estimate.')
  if (service.title === title) return
  const norm = (s: string) => s.trim().toLowerCase()
  if (services.some((s) => s.id !== serviceId && norm(s.title) === norm(title))) throw new Error('Another service on this estimate already has that name.')
  // Capture catalog identity only when the row has none yet (existing identity is locked): the
  // current label takes precedence over the new one, so relabeling a known service never repoints it.
  const capturedCatalogId = service.catalogId != null
    ? null   // already identified → COALESCE below keeps it; do not re-resolve
    : (await resolveCatalogId(service.title)) ?? (await resolveCatalogId(title))
  const capturedSnapshot = await catalogDescriptionSnapshot(capturedCatalogId)
  await db.execute(sql`
    WITH svc AS (
      SELECT id, title FROM job_services WHERE id = ${serviceId}::uuid AND job_estimate_id = ${est!.id}::uuid AND source <> 'system'
    ), upd_service AS (
      UPDATE job_services SET title = ${title}, catalog_id = COALESCE(catalog_id, ${capturedCatalogId ?? null}::uuid),
        catalog_description = CASE WHEN catalog_id IS NULL THEN ${capturedSnapshot} ELSE catalog_description END, updated_at = now()
      WHERE id IN (SELECT id FROM svc) RETURNING id
    ), upd_line AS (
      UPDATE job_line_items l SET name = ${title} FROM svc
      WHERE l.job_service_id = svc.id AND l.generated = false AND l.name = svc.title RETURNING l.id
    ), upd_order AS (
      UPDATE service_orders so SET updated_at = now(), services = (
        SELECT jsonb_agg(CASE WHEN lower(trim(a.x)) = lower(trim(svc.title)) THEN to_jsonb(${title}::text) ELSE to_jsonb(a.x) END ORDER BY a.ord)
        FROM jsonb_array_elements_text(so.services) WITH ORDINALITY AS a(x, ord))
      FROM svc
      WHERE so.id = ${orderId}::uuid AND jsonb_typeof(so.services) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(so.services) AS b(x) WHERE lower(trim(b.x)) = lower(trim(svc.title)))
      RETURNING so.id
    )
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
    SELECT ${orderId}::uuid, 'service_renamed', ${actor}, json_build_object('serviceId', svc.id, 'from', svc.title, 'to', ${title}::text)::text
    FROM svc, upd_service
  `)
}
/**
 * Remove ONE service from an estimate durably (the Estimate page's swipe-Remove).
 *
 * Deleting only the job_services row is not enough: every page open runs prepareEstimateView →
 * promoteTextServices, which re-seeds any title still present in the Job's employee-facing text
 * list (service_orders.services). So the matching text entry is removed in the SAME statement —
 * unless another remaining service still carries that name. The price line cascades; the remaining
 * services' prices/qty/tax are untouched. Audited (`service_removed`, append-only). A retail QB
 * invoice is never touched — only flagged "sync needed". Throws (nothing changed) if the service
 * isn't a user service on THIS order's estimate, so a stale page or double-tap can't fake a save.
 */
export async function removeEstimateService(orderId: string, serviceId: string, actor: string | null): Promise<{ title: string; pricingImpactCents: number | null; qbSyncNeeded: boolean }> {
  const db = getDb()
  const est = await getEstimateRow(orderId)
  const services = est ? await listUserServices(est.id) : []
  const service = services.find((s) => s.id === serviceId)
  if (!est || !service) throw new Error('That service is no longer on this estimate. Refresh to see the current list.')
  const norm = (s: string) => s.trim().toLowerCase()   // same key promoteTextServices dedupes on
  const nameStillUsed = services.some((s) => s.id !== serviceId && norm(s.title) === norm(service.title))
  const lines = await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, serviceId))
  const priced = lines.filter((l) => !l.generated).reduce((sum, l) => sum + lineAmountCents(l.priceCents, l.qty), 0)
  const pricingImpactCents = priced > 0 ? priced : null
  const key = norm(service.title)

  const res = await db.execute(sql`
    WITH del AS (
      DELETE FROM job_services WHERE id = ${serviceId}::uuid AND job_estimate_id = ${est.id}::uuid AND source <> 'system'
      RETURNING id, title
    ), upd_order AS (
      UPDATE service_orders so SET updated_at = now(), services = COALESCE((
        SELECT jsonb_agg(to_jsonb(a.x) ORDER BY a.ord)
        FROM jsonb_array_elements_text(so.services) WITH ORDINALITY AS a(x, ord)
        WHERE lower(regexp_replace(a.x, '^\\s+|\\s+$', '', 'g')) <> ${key}), '[]'::jsonb)
      FROM del
      WHERE so.id = ${orderId}::uuid AND ${!nameStillUsed}::boolean AND jsonb_typeof(so.services) = 'array'
      RETURNING so.id
    ), reopen AS (
      -- Parts whose installation relied on this line: the review re-opens (never silently "covered").
      UPDATE job_parts SET labor_status = 'needs_review', labor_service_id = NULL, labor_decided_by = ${actor}, labor_decided_at = now(), updated_at = now()
      WHERE labor_service_id IN (SELECT id FROM del) AND labor_status IN ('labor_added', 'included')
      RETURNING id
    ), ev_reopen AS (
      INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
      SELECT ${orderId}::uuid, 'part_labor_reopened', ${actor}, json_build_object('partId', reopen.id, 'serviceId', ${serviceId}::text, 'reason', 'covering labor was removed')::text FROM reopen
      RETURNING id
    ), cancel_part AS (
      -- Removing a part's own line from the estimate = that special-order part is no longer needed.
      UPDATE job_parts SET status = 'cancelled', updated_at = now(), updated_by = ${actor}
      WHERE job_service_id IN (SELECT id FROM del) AND status <> 'cancelled'
      RETURNING id
    )
    INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
    SELECT ${orderId}::uuid, 'service_removed', ${actor},
      json_build_object('serviceId', del.id, 'removed', del.title, 'pricingImpactCents', ${pricingImpactCents}::int, 'source', 'estimate')::text
    FROM del
    RETURNING id
  `)
  const rows = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('That service is no longer on this estimate. Refresh to see the current list.')

  await recomputeEstimate(est.id)   // itemized → remaining lines set the total; flat → unchanged
  const qbSyncNeeded = await flagQbSyncNeededIfInvoiced(orderId, 'a service was removed after the invoice was created')
  return { title: service.title, pricingImpactCents, qbSyncNeeded }
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
