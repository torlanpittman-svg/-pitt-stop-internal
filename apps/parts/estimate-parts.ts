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
import { randomUUID } from 'node:crypto'
import { getDb } from '@/platform/db'
import { and, eq, ne, sql } from 'drizzle-orm'
import { jobParts } from './schema'
import { jobServices, jobLineItems, serviceOrderEvents } from '@/apps/workflow/schema'
import {
  getOrCreateEstimate, getEstimateRow, addService, addLine, updateLine, removeLine, setServicePrice,
  settlePricingAfterLineChange, flagQbSyncNeededIfInvoiced, removeEstimateService,
} from '@/apps/workflow/estimate-db'
import { classifyPartWording } from '@/apps/quick-entry/service-interpret'
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
  // A customer-supplied part entered at Quick Entry also sits on the Work Board label list; drop that
  // label too (unless another live line still uses the name) so reopening never re-creates it as a service.
  const key = p.description.trim().toLowerCase()
  await getDb().execute(sql`
    UPDATE service_orders so SET updated_at = now(), services = COALESCE((
      SELECT jsonb_agg(to_jsonb(a.x) ORDER BY a.ord) FROM jsonb_array_elements_text(so.services) WITH ORDINALITY AS a(x, ord)
       WHERE lower(btrim(a.x)) <> ${key}), '[]'::jsonb)
     WHERE so.id = ${orderId}::uuid AND jsonb_typeof(so.services) = 'array'
       AND NOT EXISTS (SELECT 1 FROM job_parts jp WHERE jp.service_order_id = so.id AND jp.status <> 'cancelled' AND lower(btrim(jp.description)) = ${key})
       AND NOT EXISTS (SELECT 1 FROM job_services js JOIN job_estimates je ON je.id = js.job_estimate_id
                        WHERE je.service_order_id = so.id AND lower(btrim(js.title)) = ${key})`)
  await event(orderId, 'part_removed', actor, { partId, description: p.description, supply: p.supply })
}

/**
 * Remove a part and say what happens to its linked installation labor (job_parts.labor_service_id —
 * the persisted link, never a name guess). 'keep' (default) leaves the labor line on the estimate;
 * 'remove' also removes that labor line, but only when it is this part's linked labor and no other
 * live part relies on it. Retry-safe: the labor line is removed first (which re-opens the part's
 * labor review in the same audited statement), then the part; a retry after a partial failure skips
 * whatever already happened, and an already-removed part is a no-op instead of an error.
 */
export async function removeEstimatePartWithLabor(
  orderId: string, partId: string, labor: { action: 'keep' } | { action: 'remove'; serviceId: string } | undefined, actor: string | null,
): Promise<void> {
  const db = getDb()
  const [p] = await db.select().from(jobParts).where(and(eq(jobParts.id, partId), eq(jobParts.serviceOrderId, orderId))).limit(1)
  if (!p) throw new Error('That part is no longer on this estimate. Refresh to see the current list.')
  if (labor?.action === 'remove') {
    const est = await getEstimateRow(orderId)
    const [svc] = est ? await db.select({ id: jobServices.id }).from(jobServices)
      .where(and(eq(jobServices.id, labor.serviceId), eq(jobServices.jobEstimateId, est.id))).limit(1) : []
    if (svc) {   // still on the estimate → validate, then remove it (absent = a retry already did)
      if (p.laborServiceId !== labor.serviceId) throw new Error('That labor line isn’t linked to this part any more. Refresh to see the current list.')
      const sharing = await db.select({ description: jobParts.description }).from(jobParts)
        .where(and(eq(jobParts.serviceOrderId, orderId), eq(jobParts.laborServiceId, labor.serviceId), ne(jobParts.id, partId), ne(jobParts.status, 'cancelled')))
      if (sharing.length) throw new Error(`That labor also covers ${sharing.map((x) => `“${x.description}”`).join(', ')}, so it stays. Remove the part and keep the labor.`)
      await removeEstimateService(orderId, labor.serviceId, actor)
    }
  }
  if (p.status !== 'cancelled') await removeEstimatePart(orderId, partId, actor)
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

// ── A part saved as an ordinary service line ("Driver-side mirror assembly") ────────────────────

/** A user (non-system) estimate row of THIS order, or null. */
async function estimateRowOfOrder(orderId: string, serviceId: string) {
  const est = await getEstimateRow(orderId)
  if (!est) return null
  const [svc] = await getDb().select().from(jobServices)
    .where(and(eq(jobServices.id, serviceId), eq(jobServices.jobEstimateId, est.id), ne(jobServices.source, 'system'))).limit(1)
  return svc ? { est, svc } : null
}

const rowsOf = (res: unknown): Record<string, unknown>[] => {
  const r = (res as { rows?: unknown[] }).rows ?? res
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : []
}

export interface ConvertToPartInput { supply?: 'shop' | 'customer'; fitment?: string | null; partNumber?: string | null; supplier?: string | null }

/**
 * Convert a service line that is really a physical part into a special-order part — an explicit user
 * decision (never automatic). The SAME estimate row and its ONE priced line are kept: price, quantity,
 * taxable flag, tax category and cost are untouched, so the totals cannot move and nothing is charged
 * twice. Only the row's kind, the line's type/description (part text + fitment / part #) and a new
 * job_parts record (labor review open) change, in ONE statement; a retry or double-tap finds the row
 * already converted and returns the same part (unique live part per row, migration 0053). The original
 * wording is kept. Real work ("Paint driver-side mirror"), a catalog-matched service, or a line with
 * several price lines is refused. A linked QuickBooks invoice is flagged for sync, never rewritten.
 */
export async function convertServiceToPart(orderId: string, serviceId: string, input: ConvertToPartInput, actor: string | null): Promise<PartRow> {
  const own = await estimateRowOfOrder(orderId, serviceId)
  if (!own) throw new Error('That line is no longer on this estimate. Refresh to see the current list.')
  const { est, svc } = own
  const db = getDb()
  if (svc.kind === 'part') {
    const [existing] = await db.select().from(jobParts).where(and(eq(jobParts.jobServiceId, svc.id), ne(jobParts.status, 'cancelled'))).limit(1)
    if (existing) return existing   // already converted (retry / double-tap)
    throw new Error('That line is already a part.')
  }
  if (svc.catalogId) throw new Error(`“${svc.title}” is matched to a catalog service. Change its match first if it is really a part.`)
  if (!classifyPartWording(svc.title)) throw new Error(`“${svc.title}” describes work, not a part — it stays a service.`)
  if (input.supply === 'customer') throw new Error('A customer-supplied part has no parts charge. Keep this line as the installation labor and add the customer’s part separately.')
  const lines = (await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, svc.id))).filter((l) => !l.generated)
  if (lines.length > 1) throw new Error('This line has several prices. Clarify it (keep it as labor and add the part separately) instead of converting the whole line.')
  const fitment = text(input.fitment, 200)
  const partNumber = text(input.partNumber, 80)
  const supplier = text(input.supplier, 120)
  const description = svc.title.slice(0, 200)
  const lineDesc = partLineDescription({ description, fitment, partNumber })

  const res = await db.execute(sql`
    WITH svc AS (
      SELECT id, title FROM job_services
       WHERE id = ${svc.id}::uuid AND job_estimate_id = ${est.id}::uuid AND source <> 'system' AND kind = 'service' AND catalog_id IS NULL
    ), line AS (
      SELECT l.id, l.qty, l.price_cents, l.cost_cents, l.taxable FROM job_line_items l JOIN svc ON l.job_service_id = svc.id WHERE l.generated = false LIMIT 1
    ), upd AS (
      UPDATE job_services js SET kind = 'part', match_method = NULL, matched_by = ${actor}, matched_at = now(),
        entry_text = COALESCE(js.entry_text, left(svc.title, 300)), updated_at = now()
        FROM svc WHERE js.id = svc.id AND js.kind = 'service'
      RETURNING js.id
    ), upd_line AS (
      UPDATE job_line_items l SET type = 'part', description = ${lineDesc},
        part_number = COALESCE(${partNumber}, l.part_number), supplier = COALESCE(${supplier}, l.supplier)
        FROM line, upd WHERE l.id = line.id
      RETURNING l.id
    ), part AS (
      INSERT INTO job_parts (service_order_id, description, part_number, supplier, fitment, supply, quantity, unit_cost_cents, sell_price_cents,
        job_service_id, job_line_item_id, status, labor_status, created_by, updated_by)
      SELECT ${orderId}::uuid, ${description}, ${partNumber}, ${supplier}, ${fitment}, 'shop', COALESCE((SELECT qty FROM line), 1),
        (SELECT NULLIF(cost_cents, 0) FROM line), (SELECT price_cents FROM line), upd.id, (SELECT id FROM line), 'needed', 'needs_review', ${actor}, ${actor}
        FROM upd
      RETURNING id
    ), reopen AS (
      -- Parts that counted on this line as their installation labor: a part can't install a part.
      UPDATE job_parts SET labor_status = 'needs_review', labor_service_id = NULL, labor_decided_by = ${actor}, labor_decided_at = now(), updated_at = now()
       WHERE labor_service_id IN (SELECT id FROM upd) AND labor_status IN ('labor_added', 'included')
      RETURNING id
    ), ev_reopen AS (
      INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
      SELECT ${orderId}::uuid, 'part_labor_reopened', ${actor}, json_build_object('partId', reopen.id, 'serviceId', ${svc.id}::text, 'reason', 'covering line was converted to a part')::text FROM reopen
      RETURNING id
    ), ev AS (
      INSERT INTO service_order_events(service_order_id, event_type, employee_name, note)
      SELECT ${orderId}::uuid, 'service_converted_to_part', ${actor},
        json_build_object('serviceId', ${svc.id}::text, 'partId', part.id, 'description', ${description}::text, 'entry', ${svc.entryText}::text,
          'priceCents', (SELECT price_cents FROM line), 'qty', (SELECT qty FROM line), 'taxable', (SELECT taxable FROM line),
          'fitment', ${fitment}::text, 'partNumber', ${partNumber}::text, 'unchanged', 'price, quantity, tax')::text
        FROM part
      RETURNING id
    )
    SELECT id FROM part
  `)
  const partId = rowsOf(res)[0]?.id as string | undefined
  const [row] = await db.select().from(jobParts)
    .where(partId ? eq(jobParts.id, partId) : and(eq(jobParts.jobServiceId, svc.id), ne(jobParts.status, 'cancelled'))).limit(1)
  if (!row) throw new Error('That line changed while converting. Refresh and try again.')
  await flagQbSyncNeededIfInvoiced(orderId, 'a service line was converted to a part')
  return row
}

/**
 * Clarify a part-like line that is really (or also) WORK — e.g. "Replace windshield" priced as one
 * job, or installing a customer's tires: the line stays exactly as it is (price untouched) and is
 * confirmed as a service, the part is added separately (shop part at the price the user enters —
 * blank allowed — or a customer-supplied part with no charge), and that part's installation labor is
 * linked to this line ("already included").
 *
 * ATOMIC + IDEMPOTENT. Every write — confirm the line as labor, create the part's estimate row and
 * priced line, the job_parts record, link the labor, and the audit — happens in ONE SQL statement, so
 * a failure can never leave the review cleared without a part, an unpriced orphan line, or a half-
 * linked part. (The Neon HTTP driver has single-statement/batch execution but not interactive
 * multi-statement `db.transaction`; this is deliberately one statement so the whole graph commits or
 * rolls back together.) A retry, double-tap, or two simultaneous requests collapse to ONE part via the
 * clarify CLAIM (job_parts_clarify_uniq, migration 0054) — ON CONFLICT DO NOTHING. Derived pricing and
 * the QB-sync flag are finalized on BOTH the first-write and the retry path from the SAVED part (never
 * stale request values), so a crash AFTER the commit but before the recompute is fully repaired by a
 * retry. All input is validated BEFORE any write (an invalid quantity/price rejects with the part
 * review still intact). A retry with the SAME input returns the saved part; a retry that CHANGES the
 * price/quantity/cost/fitment/part#/supplier is refused with a clear "already added — edit it" error
 * rather than silently discarding the change.
 */
export async function clarifyServiceWithPart(orderId: string, serviceId: string, input: EstimatePartInput, actor: string | null, role: string | null): Promise<PartRow> {
  const own = await estimateRowOfOrder(orderId, serviceId)
  if (!own || own.svc.kind === 'part') throw new Error('That line is no longer a service on this estimate. Refresh to see the current list.')
  const { est, svc } = own
  // Validate EVERYTHING before touching the database (so a bad quantity/price can't clear the review).
  const description = text(input.description, 200)
  if (!description) throw new Error('Describe the part (e.g. “Windshield”).')
  const supply: 'shop' | 'customer' = input.supply === 'customer' ? 'customer' : 'shop'
  const quantity = qtyOf(input.quantity)
  const unitCostCents = money(input.unitCostCents)
  const sellPriceCents = supply === 'customer' ? null : money(input.sellPriceCents)
  const fitment = text(input.fitment, 200)
  const partNumber = text(input.partNumber, 80)
  const supplier = text(input.supplier, 120)
  const entryText = (input.entryText ?? svc.entryText ?? svc.title)?.slice(0, 300) ?? null
  // "Already included on this line" must be a valid labor decision (manager rule is enforced for waivers,
  // not for linking) — this also proves the clarified line is a legitimate cover for the part.
  const err = validateLaborDecision({ status: 'included', serviceId: svc.id }, { role, coverable: new Set([svc.id]) })
  if (err) throw new Error(err)
  const lineDesc = partLineDescription({ description, fitment, partNumber })
  // Pre-generate the part estimate row + line ids so the whole graph can be inserted in one statement
  // with forward references (no row is written twice); foreign keys are checked at statement end.
  const partSvcId = randomUUID()
  const partLineId = randomUUID()
  const shopSvcId = supply === 'shop' ? partSvcId : null
  const shopLineId = supply === 'shop' && sellPriceCents != null ? partLineId : null
  const db = getDb()

  const res = await db.execute(sql`
    WITH svc AS (
      SELECT id FROM job_services
       WHERE id = ${svc.id}::uuid AND job_estimate_id = ${est.id}::uuid AND source <> 'system' AND kind = 'service'
    ), claim AS (
      INSERT INTO job_parts (service_order_id, description, part_number, supplier, fitment, supply, quantity,
        unit_cost_cents, sell_price_cents, job_service_id, job_line_item_id, labor_service_id, clarifies_service_id,
        status, labor_status, labor_decided_by, labor_decided_at, created_by, updated_by, created_at, updated_at)
      SELECT ${orderId}::uuid, ${description}, ${partNumber}, ${supplier}, ${fitment}, ${supply}, ${String(quantity)}::numeric,
        ${unitCostCents}::int, ${sellPriceCents}::int, ${shopSvcId}::uuid, ${shopLineId}::uuid, svc.id, svc.id,
        'needed', 'included', ${actor}, now(), ${actor}, ${actor}, now(), now()
      FROM svc
      ON CONFLICT (clarifies_service_id, description, supply) WHERE clarifies_service_id IS NOT NULL AND status <> 'cancelled'
      DO NOTHING
      RETURNING id
    ), part_svc AS (
      -- A shop part bills on its own estimate row; a customer-supplied part has none.
      INSERT INTO job_services (id, job_estimate_id, title, source, kind, entry_text, sort_order, created_at, updated_at)
      SELECT ${partSvcId}::uuid, ${est.id}::uuid, ${description}, 'manual', 'part', ${entryText}, 0, now(), now()
      FROM claim WHERE ${supply} = 'shop'
      RETURNING id
    ), part_line AS (
      -- Only when a price was entered (blank is allowed and stays unpriced). job_line_items has no updated_at.
      INSERT INTO job_line_items (id, job_service_id, type, name, description, qty, unit, cost_cents, price_cents, taxable, tax_category, part_number, supplier, created_at)
      SELECT ${partLineId}::uuid, ${partSvcId}::uuid, 'part', ${description}, ${lineDesc}, ${String(quantity)}, 'each',
        ${unitCostCents ?? 0}::int, ${sellPriceCents}::int, false, 'repair_parts', ${partNumber}, ${supplier}, now()
      FROM part_svc WHERE ${sellPriceCents}::int IS NOT NULL
      RETURNING id
    ), upd_orig AS (
      -- The clarified line is confirmed as labor (keeps its price); only when it had no identity yet.
      UPDATE job_services SET match_method = 'custom', matched_by = ${actor}, matched_at = now(), updated_at = now()
       WHERE id = ${svc.id}::uuid AND catalog_id IS NULL AND match_method IS DISTINCT FROM 'custom' AND EXISTS (SELECT 1 FROM claim)
      RETURNING id
    ), ev_match AS (
      INSERT INTO service_order_events (service_order_id, event_type, employee_name, note)
      SELECT ${orderId}::uuid, 'service_matched', ${actor},
        json_build_object('serviceId', ${svc.id}::text, 'to', json_build_object('custom', true), 'reason', 'clarified as labor; part added separately')::text
      FROM upd_orig
      RETURNING id
    ), ev_part AS (
      INSERT INTO service_order_events (service_order_id, event_type, employee_name, note)
      SELECT ${orderId}::uuid, 'part_added', ${actor},
        json_build_object('partId', claim.id, 'description', ${description}::text, 'supply', ${supply}::text,
          'quantity', ${quantity}::numeric, 'sellPriceCents', ${sellPriceCents}::int, 'via', 'clarify', 'laborServiceId', ${svc.id}::text)::text
      FROM claim
      RETURNING id
    ), ev_labor AS (
      INSERT INTO service_order_events (service_order_id, event_type, employee_name, note)
      SELECT ${orderId}::uuid, 'part_labor_review', ${actor},
        json_build_object('partId', claim.id, 'part', ${description}::text, 'status', 'included', 'laborServiceId', ${svc.id}::text)::text
      FROM claim
      RETURNING id
    )
    SELECT id FROM claim
  `)

  const wonId = rowsOf(res)[0]?.id as string | undefined
  const [saved] = wonId
    ? await db.select().from(jobParts).where(eq(jobParts.id, wonId)).limit(1)
    : await db.select().from(jobParts)
        .where(and(eq(jobParts.serviceOrderId, orderId), eq(jobParts.clarifiesServiceId, svc.id), eq(jobParts.description, description), eq(jobParts.supply, supply), ne(jobParts.status, 'cancelled'))).limit(1)
  // No claim and no prior part → the service line wasn't a live service of this order after all.
  if (!saved) throw new Error('That line is no longer a service on this estimate. Refresh to see the current list.')

  // Finalize derived pricing + QB-sync on BOTH the first-write and the retry/duplicate path, using the
  // SAVED part (not stale request values). Idempotent (recompute is derived from the lines), so a
  // post-commit crash before this step is fully repaired when the client retries.
  await settlePricingAfterLineChange(est.id, saved.sellPriceCents != null)
  await flagQbSyncNeededIfInvoiced(orderId, 'a part was added')

  // A retry/double-tap with the SAME input returns the saved part; a conflicting retry that tries to
  // CHANGE it is refused (the saved part is untouched) so the user's new values are never silently lost.
  if (!wonId) {
    const changed = Number(saved.quantity) !== quantity || saved.unitCostCents !== unitCostCents || saved.sellPriceCents !== sellPriceCents
      || saved.fitment !== fitment || saved.partNumber !== partNumber || saved.supplier !== supplier
    if (changed) throw new Error('A part was already added to clarify this line. Edit that part to change its price, quantity, or details.')
  }
  return saved
}
