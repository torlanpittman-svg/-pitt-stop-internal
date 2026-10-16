/**
 * Special-order parts on the estimate + installation-labor review — data layer.
 *
 * We stock no parts and keep no SKUs: every part is bought for a specific job. A shop-supplied part
 * is ONE estimate row (job_services.kind='part') with ONE line (type 'part': vendor cost and customer
 * selling price kept separate, qty, the real description / fitment / vendor part number), billed on
 * the QuickBooks invoice under the EXISTING general parts item. Procurement detail stays in the
 * existing job_parts record (same row the Job-detail Parts tracker uses). A customer-supplied part
 * has no parts charge (no estimate row) but still gets an installation-labor review.
 *
 * Nothing here invents a parts/labor split, a price, or a quantity: prices are only what the user
 * enters. All changes are audited (service_order_events, append-only).
 */
import { getDb } from '@/platform/db'
import { and, eq, ne } from 'drizzle-orm'
import { jobParts } from './schema'
import { jobServices, jobLineItems, serviceOrderEvents } from '@/apps/workflow/schema'
import {
  getOrCreateEstimate, getEstimateRow, addService, addLine, updateLine, removeLine, setServicePrice,
  settlePricingAfterLineChange, flagQbSyncNeededIfInvoiced, removeEstimateService,
} from '@/apps/workflow/estimate-db'
import { partLineDescription, cleanDetail } from '@/apps/quickbooks/retail-format'
import { listCatalogChoices } from '@/apps/quick-entry/service-match-db'
import { validateLaborDecision, effectiveLaborStatus, type LaborDecision } from './labor-review'

type PartRow = typeof jobParts.$inferSelect

async function event(orderId: string, eventType: string, actor: string | null, note: Record<string, unknown>) {
  await getDb().insert(serviceOrderEvents).values({ serviceOrderId: orderId, eventType, employeeName: actor, note: JSON.stringify(note) })
}

const money = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 0) throw new Error('Enter a valid amount.')
  return n
}
const qtyOf = (v: unknown, fallback = 1): number => {
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > 999) throw new Error('Enter a quantity greater than zero.')
  return Math.round(n * 100) / 100
}
const text = (v: unknown, max: number): string | null => cleanDetail(v)?.slice(0, max) ?? null

export interface EstimatePartInput {
  description: string
  supply?: 'shop' | 'customer'
  fitment?: string | null
  partNumber?: string | null
  supplier?: string | null
  quantity?: number | string | null
  /** Vendor cost per unit (internal). */
  unitCostCents?: number | string | null
  /** Customer selling price per unit. Null = not priced yet (estimate shows it as unpriced). */
  sellPriceCents?: number | string | null
  entryText?: string | null
}

async function ownPart(orderId: string, partId: string): Promise<PartRow> {
  const [p] = await getDb().select().from(jobParts).where(and(eq(jobParts.id, partId), eq(jobParts.serviceOrderId, orderId), ne(jobParts.status, 'cancelled'))).limit(1)
  if (!p) throw new Error('That part is no longer on this estimate. Refresh to see the current list.')
  return p
}

/** Add a special-order (shop) or customer-supplied part. Labor review starts open. */
export async function addEstimatePart(orderId: string, input: EstimatePartInput, actor: string | null): Promise<PartRow> {
  const description = text(input.description, 200)
  if (!description) throw new Error('Describe the part (e.g. “Driver-side mirror assembly”).')
  const supply = input.supply === 'customer' ? 'customer' : 'shop'
  const quantity = qtyOf(input.quantity)
  const unitCostCents = money(input.unitCostCents)
  const sellPriceCents = supply === 'customer' ? null : money(input.sellPriceCents)
  const fitment = text(input.fitment, 200)
  const partNumber = text(input.partNumber, 80)
  const supplier = text(input.supplier, 120)
  const est = await getOrCreateEstimate(orderId, actor)

  let jobServiceId: string | null = null
  let jobLineItemId: string | null = null
  if (supply === 'shop') {
    const svc = await addService(est.id, description, { kind: 'part', actor, entryText: input.entryText ?? null })
    jobServiceId = svc.id
    if (sellPriceCents != null) {
      const line = await addLine(svc.id, {
        type: 'part', name: description, description: partLineDescription({ description, fitment, partNumber }),
        qty: quantity, unit: 'each', costCents: unitCostCents ?? 0, priceCents: sellPriceCents,
        // Retail QuickBooks lines are non-taxable (TaxCodeRef NON) — see the release notes for the tax decision.
        taxable: false, taxCategory: 'repair_parts', partNumber, supplier,
      })
      jobLineItemId = line.id
    }
  }
  const [row] = await getDb().insert(jobParts).values({
    serviceOrderId: orderId, description, partNumber, supplier, fitment, supply,
    quantity: String(quantity), unitCostCents, sellPriceCents,
    jobServiceId, jobLineItemId, status: 'needed', laborStatus: 'needs_review',
    createdBy: actor, updatedBy: actor,
  }).returning()
  await event(orderId, 'part_added', actor, { partId: row.id, description, supply, quantity, unitCostCents, sellPriceCents, fitment, partNumber, entry: input.entryText ?? null })
  if (supply === 'shop') await settlePricingAfterLineChange(est.id, sellPriceCents != null)
  await flagQbSyncNeededIfInvoiced(orderId, 'a part was added')
  return row
}

export type EstimatePartPatch = Partial<Pick<EstimatePartInput, 'description' | 'fitment' | 'partNumber' | 'supplier' | 'quantity' | 'unitCostCents' | 'sellPriceCents'>>

/** Edit a part. Only the fields sent change; price/qty/cost change only when explicitly edited. */
export async function updateEstimatePart(orderId: string, partId: string, patch: EstimatePartPatch, actor: string | null): Promise<void> {
  const p = await ownPart(orderId, partId)
  const db = getDb()
  const description = patch.description !== undefined ? text(patch.description, 200) : p.description
  if (!description) throw new Error('Describe the part.')
  const next = {
    description,
    fitment: patch.fitment !== undefined ? text(patch.fitment, 200) : p.fitment,
    partNumber: patch.partNumber !== undefined ? text(patch.partNumber, 80) : p.partNumber,
    supplier: patch.supplier !== undefined ? text(patch.supplier, 120) : p.supplier,
    quantity: patch.quantity !== undefined ? qtyOf(patch.quantity) : Number(p.quantity),
    unitCostCents: patch.unitCostCents !== undefined ? money(patch.unitCostCents) : p.unitCostCents,
    sellPriceCents: p.supply === 'customer' ? null : patch.sellPriceCents !== undefined ? money(patch.sellPriceCents) : p.sellPriceCents,
  }
  await db.update(jobParts).set({ ...next, quantity: String(next.quantity), updatedAt: new Date(), updatedBy: actor }).where(eq(jobParts.id, partId))

  if (p.supply === 'shop' && p.jobServiceId) {
    const [svc] = await db.select().from(jobServices).where(eq(jobServices.id, p.jobServiceId)).limit(1)
    if (svc) {
      if (next.description !== svc.title) await db.update(jobServices).set({ title: next.description, updatedAt: new Date() }).where(eq(jobServices.id, svc.id))
      const [line] = await db.select().from(jobLineItems).where(and(eq(jobLineItems.jobServiceId, svc.id), eq(jobLineItems.generated, false))).limit(1)
      const lineDesc = partLineDescription(next)
      let linkedLineId: string | null = line?.id ?? null
      if (next.sellPriceCents == null) {
        if (line) { await removeLine(line.id); linkedLineId = null }
      } else if (line) {
        await updateLine(line.id, { name: next.description, description: lineDesc, qty: next.quantity, costCents: next.unitCostCents ?? 0, priceCents: next.sellPriceCents })
      } else {
        const created = await addLine(svc.id, { type: 'part', name: next.description, description: lineDesc, qty: next.quantity, unit: 'each',
          costCents: next.unitCostCents ?? 0, priceCents: next.sellPriceCents, taxable: false, taxCategory: 'repair_parts', partNumber: next.partNumber, supplier: next.supplier })
        linkedLineId = created.id
      }
      if (linkedLineId !== p.jobLineItemId) await db.update(jobParts).set({ jobLineItemId: linkedLineId }).where(eq(jobParts.id, partId))
      await settlePricingAfterLineChange(svc.jobEstimateId, next.sellPriceCents != null)
    }
  }
  await event(orderId, 'part_updated', actor, { partId, before: { description: p.description, quantity: Number(p.quantity), unitCostCents: p.unitCostCents, sellPriceCents: p.sellPriceCents, fitment: p.fitment, partNumber: p.partNumber }, after: next })
  await flagQbSyncNeededIfInvoiced(orderId, 'a part changed')
}

/** Remove a part from the estimate: its line goes (durably), the procurement record is cancelled. */
export async function removeEstimatePart(orderId: string, partId: string, actor: string | null): Promise<void> {
  const p = await ownPart(orderId, partId)
  if (p.jobServiceId) {
    await removeEstimateService(orderId, p.jobServiceId, actor)   // cancels the part in the same statement
    return
  }
  await getDb().update(jobParts).set({ status: 'cancelled', updatedAt: new Date(), updatedBy: actor }).where(eq(jobParts.id, partId))
  await event(orderId, 'part_removed', actor, { partId, description: p.description, supply: p.supply })
}

/** Live work services on the estimate that can cover installation (never a part's own row). */
async function coverableServiceIds(orderId: string): Promise<Set<string>> {
  const est = await getEstimateRow(orderId)
  if (!est) return new Set()
  const rows = await getDb().select({ id: jobServices.id }).from(jobServices)
    .where(and(eq(jobServices.jobEstimateId, est.id), ne(jobServices.source, 'system'), ne(jobServices.kind, 'part')))
  return new Set(rows.map((r) => r.id))
}

/** The catalog's installation-labor service (role 'installation'), or null. */
export async function installationCatalog() {
  return (await listCatalogChoices()).find((c) => c.role === 'installation') ?? null
}

export type LaborAction =
  | { action: 'add_labor'; cents?: number | string | null; detail?: string | null }
  | { action: 'included'; serviceId: string }
  | { action: 'part_only' }
  | { action: 'waive'; reason: string }
  | { action: 'reopen' }

/**
 * Resolve (or re-open) a part's installation-labor review. `add_labor` adds the EXISTING
 * installation catalog service (price only if the user entered one) and links it; `included` links
 * an existing line the user says covers installation; one labor line may cover several parts.
 * Waivers are manager-only with a reason. Audited (part_labor_review).
 */
export async function decidePartLabor(orderId: string, partId: string, a: LaborAction, actor: string | null, role: string | null): Promise<void> {
  const p = await ownPart(orderId, partId)
  let decision: LaborDecision
  let coverable = await coverableServiceIds(orderId)
  if (a.action === 'add_labor') {
    if (effectiveLaborStatus(p, coverable) === 'labor_added') throw new Error('Installation labor is already linked to this part.')
    const install = await installationCatalog()
    if (!install) throw new Error('No installation service is set up in the catalog. Ask a manager to review the catalog.')
    const est = await getOrCreateEstimate(orderId, actor)
    const cents = money(a.cents)
    const detail = cleanDetail(a.detail) ?? p.description
    const svc = await addService(est.id, install.name, { catalogId: install.catalogId, matchMethod: 'rule', detail, actor })
    if (cents != null) await setServicePrice(est.id, svc.id, cents, actor)
    else await settlePricingAfterLineChange(est.id, false)
    coverable = new Set([...coverable, svc.id])
    decision = { status: 'labor_added', serviceId: svc.id }
  } else if (a.action === 'included') decision = { status: 'included', serviceId: a.serviceId }
  else if (a.action === 'part_only') decision = { status: 'part_only' }
  else if (a.action === 'waive') decision = { status: 'waived', reason: a.reason }
  else decision = { status: 'needs_review' }

  const err = validateLaborDecision(decision, { role, coverable })
  if (err) throw new Error(err)
  const laborServiceId = decision.status === 'labor_added' || decision.status === 'included' ? decision.serviceId : null
  const laborNote = decision.status === 'waived' ? decision.reason.replace(/\s+/g, ' ').trim() : null
  await getDb().update(jobParts).set({ laborStatus: decision.status, laborServiceId, laborNote, laborDecidedBy: actor, laborDecidedAt: new Date(), updatedAt: new Date(), updatedBy: actor })
    .where(eq(jobParts.id, partId))
  await event(orderId, 'part_labor_review', actor, { partId, part: p.description, status: decision.status, laborServiceId, reason: laborNote })
  if (a.action === 'add_labor') await flagQbSyncNeededIfInvoiced(orderId, 'installation labor was added')
}

export interface TireWorkInput {
  /** supply = we sell tires only; install_customer = install customer-supplied tires; both = supply + install */
  mode: 'supply' | 'install_customer' | 'both'
  quantity: number | string
  size?: string | null
  /** Per-tire selling price (supply/both). Null = not priced yet. */
  tireUnitCents?: number | string | null
  /** Installation price (install_customer/both). Null = not priced yet. Never derived from a combined price. */
  installCents?: number | string | null
  /** Only what was explicitly included in the work. */
  extras?: { mount?: boolean; balance?: boolean; disposal?: boolean }
  entryText?: string | null
}

/**
 * "Replace tires": an explicit choice of supply / install customer-supplied / both, and a confirmed
 * quantity. Supplying + installing bills the tires (parts) and installation (labor) separately, each
 * at the price the user entered. Mounting/balancing/disposal appear only when explicitly ticked.
 */
export async function addTireWork(orderId: string, input: TireWorkInput, actor: string | null, role: string | null): Promise<void> {
  const quantity = Number(input.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new Error('Confirm how many tires (1–12).')
  if (!['supply', 'install_customer', 'both'].includes(input.mode)) throw new Error('Choose: supplying tires, installing customer-supplied tires, or both.')
  const size = text(input.size, 40)
  const noun = `${quantity === 1 ? 'Tire' : 'Tires'}${size ? ` ${size}` : ''}`
  const extras = [input.extras?.mount && 'mounting', input.extras?.balance && 'balancing', input.extras?.disposal && 'disposal of old tires'].filter(Boolean) as string[]
  const installDetail = `${quantity} ${input.mode === 'install_customer' ? 'customer-supplied ' : ''}${quantity === 1 ? 'tire' : 'tires'}${extras.length ? `, including ${extras.join(', ')}` : ''}`
  const part = await addEstimatePart(orderId, {
    description: input.mode === 'install_customer' ? `Customer-supplied ${noun.toLowerCase()}` : noun,
    supply: input.mode === 'install_customer' ? 'customer' : 'shop',
    quantity, sellPriceCents: input.mode === 'install_customer' ? null : input.tireUnitCents ?? null, entryText: input.entryText ?? null,
  }, actor)
  if (input.mode === 'supply') await decidePartLabor(orderId, part.id, { action: 'part_only' }, actor, role)
  else await decidePartLabor(orderId, part.id, { action: 'add_labor', cents: input.installCents ?? null, detail: installDetail }, actor, role)
}
