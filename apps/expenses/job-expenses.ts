/**
 * Job expenses — the link between a PURCHASE (one business_receipts row) and a customer job / overhead.
 *
 * SOURCE OF TRUTH: the receipt row is the expense. An allocation (expense_allocations) only says which job
 * (or overhead) that purchase — or part of it — was for. Nothing in this file creates an expense, and no
 * business total reads allocations, so attaching a job can never raise total business expenses.
 *
 * Writes are append-style: an allocation is inserted; a correction/reassignment marks the old row 'removed'
 * (replaced_by → its successor) and inserts a new one; every change is appended to the receipt's audit_log.
 * Nothing is ever deleted. No QuickBooks call, no invoice change, no money movement.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { serviceOrders, vehicles } from '@/apps/workflow/schema'
import { jobParts } from '@/apps/parts/schema'
import { finReceiptMatches } from '@/apps/finance/schema'
import { businessReceipts, expenseAllocations } from './schema'
import { appendReceiptAudit, getReceipt } from './db'
import { auditEntry, isCompleteStatus } from './types'
import { checkNewAllocation, effectiveAmountCents, summarizeAllocations, type AllocationSummary, type AllocationTarget } from './allocations'
import { receiptPaymentLabel } from './payment'
import { receiptImagePath } from './view'

export type AllocationRow = typeof expenseAllocations.$inferSelect
export interface Actor { name: string | null; key: string | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown; message?: unknown }; message?: unknown }
  if (e?.code === '23505' || e?.cause?.code === '23505') return true
  return /duplicate key value|unique constraint|23505/i.test(`${String(e?.message ?? '')} ${String(e?.cause?.message ?? '')}`)
}

// ── Job lookup (the picker on general Receipts, and the "For: …" chip when capture starts from a job) ──
export interface JobRef {
  id: string; orderNumber: string; status: string
  customerName: string | null; vehicle: string; vin: string | null
}
const vehicleLabel = (v: { year: string | null; make: string | null; model: string | null }) => [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle'
export function jobLabel(j: JobRef): string {
  return [j.customerName || 'Customer', j.vehicle, j.orderNumber].filter(Boolean).join(' · ')
}
const jobCols = {
  id: serviceOrders.id, orderNumber: serviceOrders.orderNumber, status: serviceOrders.status, customerName: serviceOrders.customerName,
  year: vehicles.year, make: vehicles.make, model: vehicles.model, vin: vehicles.vin,
}
type JobColsRow = { id: string; orderNumber: string; status: string; customerName: string | null; year: string | null; make: string | null; model: string | null; vin: string | null }
const toJobRef = (r: JobColsRow): JobRef => ({ id: r.id, orderNumber: r.orderNumber, status: r.status, customerName: r.customerName, vehicle: vehicleLabel(r), vin: r.vin })

export async function getJobRef(orderId: string): Promise<JobRef | null> {
  if (!isUuid(orderId)) return null
  const [r] = await getDb().select(jobCols).from(serviceOrders).innerJoin(vehicles, eq(serviceOrders.vehicleId, vehicles.id))
    .where(eq(serviceOrders.id, orderId)).limit(1)
  return r ? toJobRef(r as JobColsRow) : null
}

/** Split a search box into at most 5 lowercase LIKE-safe tokens. Pure (exported for tests). */
export function searchTokens(q: string): string[] {
  return q.toLowerCase().split(/\s+/).map((t) => t.replace(/[%_\\]/g, '').trim()).filter((t) => t.length >= 2).slice(0, 5)
}

/**
 * Find customer jobs by customer name, vehicle (year/make/model), VIN, or job number. Every token must match
 * at least one of those fields. Newest first; cancelled jobs are left out (they are soft-removed work).
 */
export async function searchJobs(q: string, limit = 8): Promise<JobRef[]> {
  const tokens = searchTokens(q)
  if (tokens.length === 0) return []
  const conds = tokens.map((t) => {
    const like = `%${t}%`
    return sql`(lower(coalesce(${serviceOrders.customerName}, '')) like ${like}
      or lower(${serviceOrders.orderNumber}) like ${like}
      or lower(coalesce(${vehicles.vin}, '')) like ${like}
      or lower(coalesce(${vehicles.make}, '')) like ${like}
      or lower(coalesce(${vehicles.model}, '')) like ${like}
      or coalesce(${vehicles.year}, '') like ${like})`
  })
  const rows = await getDb().select(jobCols).from(serviceOrders).innerJoin(vehicles, eq(serviceOrders.vehicleId, vehicles.id))
    .where(and(ne(serviceOrders.status, 'cancelled'), ...conds)).orderBy(desc(serviceOrders.createdAt)).limit(Math.min(Math.max(limit, 1), 20))
  return (rows as JobColsRow[]).map(toJobRef)
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────
export async function activeAllocationsForReceipt(receiptId: string): Promise<AllocationRow[]> {
  return getDb().select().from(expenseAllocations)
    .where(and(eq(expenseAllocations.receiptId, receiptId), eq(expenseAllocations.status, 'active'))).orderBy(expenseAllocations.createdAt)
}

export interface ReceiptAllocationView {
  id: string; target: AllocationTarget; serviceOrderId: string | null; jobLabel: string | null
  amountCents: number | null; effectiveCents: number | null; note: string | null; jobPartId: string | null
}
/** Active allocations (with a job label) for a set of receipts — for the review card + the reconciliation view. */
export async function allocationViewsFor(receiptIds: string[]): Promise<Map<string, ReceiptAllocationView[]>> {
  const out = new Map<string, ReceiptAllocationView[]>()
  if (receiptIds.length === 0) return out
  const db = getDb()
  const rows = await db.select({
    a: expenseAllocations, total: businessReceipts.totalCents,
    orderNumber: serviceOrders.orderNumber, customerName: serviceOrders.customerName, orderStatus: serviceOrders.status,
    year: vehicles.year, make: vehicles.make, model: vehicles.model, vin: vehicles.vin,
  }).from(expenseAllocations)
    .innerJoin(businessReceipts, eq(expenseAllocations.receiptId, businessReceipts.id))
    .leftJoin(serviceOrders, eq(expenseAllocations.serviceOrderId, serviceOrders.id))
    .leftJoin(vehicles, eq(serviceOrders.vehicleId, vehicles.id))
    .where(and(inArray(expenseAllocations.receiptId, receiptIds), eq(expenseAllocations.status, 'active')))
    .orderBy(expenseAllocations.createdAt)
  for (const r of rows) {
    const label = r.a.target === 'job' && r.orderNumber
      ? jobLabel({ id: r.a.serviceOrderId as string, orderNumber: r.orderNumber, status: r.orderStatus ?? '', customerName: r.customerName, vehicle: vehicleLabel(r), vin: r.vin })
      : null
    const list = out.get(r.a.receiptId) ?? []
    list.push({
      id: r.a.id, target: r.a.target as AllocationTarget, serviceOrderId: r.a.serviceOrderId, jobLabel: label,
      amountCents: r.a.amountCents, effectiveCents: effectiveAmountCents(r.a, r.total), note: r.a.note, jobPartId: r.a.jobPartId,
    })
    out.set(r.a.receiptId, list)
  }
  return out
}

export interface JobExpenseItem {
  allocationId: string; receiptId: string
  vendor: string | null; description: string | null; receiptDate: string | null
  amountCents: number | null            // what THIS job carries (the whole purchase, or its split amount)
  wholePurchase: boolean
  receiptTotalCents: number | null; subtotalCents: number | null; taxCents: number | null; shippingCents: number | null
  invoiceNumber: string | null; orderNumber: string | null
  paymentLabel: string                  // exactly what was recorded — never guessed
  receiptStatus: string
  recorded: boolean                     // filed/approved → counts in the job total; else pending review
  receiptUrl: string | null; contentType: string | null
  note: string | null; jobPartId: string | null
  purchase: AllocationSummary           // how the WHOLE purchase is allocated (remainder / over-allocation)
  bankMatch: 'confirmed' | 'dismissed' | 'none'  // fin_receipt_matches — a human-confirmed bank/card transaction
  qbSyncStatus: string                  // 'synced' only when a real QuickBooks record exists (never assumed)
}
export interface UnlinkedPartCost { partId: string; description: string; quantity: number; unitCostCents: number; costCents: number }
export interface JobExpenses {
  items: JobExpenseItem[]
  recordedCents: number                 // sum over FILED/APPROVED purchases — each allocation counted once
  recordedCount: number
  pendingCents: number                  // attached, but the receipt still needs review (NOT in recordedCents)
  pendingCount: number
  // Job part lines carrying an internal cost that are NOT tied to a receipt. Shown separately and never added
  // to recordedCents: a part's typed cost and a receipt for the same part are one purchase, not two.
  unlinkedPartCosts: UnlinkedPartCost[]
  unlinkedPartCostCents: number
}

/** Pure roll-up of a job's expense items (exported for tests): recorded vs pending, each allocation once. */
export function rollUpJobExpenses(items: Pick<JobExpenseItem, 'amountCents' | 'recorded'>[]): Pick<JobExpenses, 'recordedCents' | 'recordedCount' | 'pendingCents' | 'pendingCount'> {
  let recordedCents = 0, recordedCount = 0, pendingCents = 0, pendingCount = 0
  for (const i of items) {
    if (i.recorded) { recordedCents += i.amountCents ?? 0; recordedCount++ }
    else { pendingCents += i.amountCents ?? 0; pendingCount++ }
  }
  return { recordedCents, recordedCount, pendingCents, pendingCount }
}

/** Everything recorded against ONE job: its receipt-backed expenses (each once) + unreconciled part costs. */
export async function listJobExpenses(orderId: string): Promise<JobExpenses> {
  const db = getDb()
  const rows = await db.select({ a: expenseAllocations, r: businessReceipts }).from(expenseAllocations)
    .innerJoin(businessReceipts, eq(expenseAllocations.receiptId, businessReceipts.id))
    .where(and(eq(expenseAllocations.serviceOrderId, orderId), eq(expenseAllocations.target, 'job'),
      eq(expenseAllocations.status, 'active'), ne(businessReceipts.status, 'rejected')))
    .orderBy(desc(expenseAllocations.createdAt))
  const receiptIds = [...new Set(rows.map((x) => x.r.id))]
  const [allActive, matches] = receiptIds.length === 0 ? [[], []] : await Promise.all([
    db.select().from(expenseAllocations).where(and(inArray(expenseAllocations.receiptId, receiptIds), eq(expenseAllocations.status, 'active'))),
    db.select({ receiptId: finReceiptMatches.receiptId, status: finReceiptMatches.status }).from(finReceiptMatches).where(inArray(finReceiptMatches.receiptId, receiptIds)),
  ])
  const matchBy = new Map(matches.map((m) => [m.receiptId, m.status]))
  const items: JobExpenseItem[] = rows.map(({ a, r }) => {
    const hasFile = r.storage !== 'none' && !!r.storageRef
    const m = matchBy.get(r.id)
    return {
      allocationId: a.id, receiptId: r.id, vendor: r.vendor, description: r.description, receiptDate: r.receiptDate,
      amountCents: effectiveAmountCents(a, r.totalCents), wholePurchase: a.amountCents == null,
      receiptTotalCents: r.totalCents, subtotalCents: r.subtotalCents, taxCents: r.taxCents, shippingCents: r.shippingCents,
      invoiceNumber: r.invoiceNumber, orderNumber: r.orderNumber,
      paymentLabel: receiptPaymentLabel(r), receiptStatus: r.status, recorded: isCompleteStatus(r.status),
      receiptUrl: hasFile ? receiptImagePath(r.id) : null, contentType: r.contentType,
      note: a.note, jobPartId: a.jobPartId,
      purchase: summarizeAllocations(r.totalCents, allActive.filter((x) => x.receiptId === r.id)),
      bankMatch: m === 'confirmed' ? 'confirmed' : m === 'dismissed' ? 'dismissed' : 'none',
      qbSyncStatus: r.qbSyncStatus,
    }
  })
  // Part lines with an internal cost that no active allocation on this job points at.
  const linkedPartIds = new Set(rows.map((x) => x.a.jobPartId).filter(Boolean) as string[])
  const parts = await db.select({ id: jobParts.id, description: jobParts.description, quantity: jobParts.quantity, unitCostCents: jobParts.unitCostCents })
    .from(jobParts).where(and(eq(jobParts.serviceOrderId, orderId), ne(jobParts.status, 'cancelled'), eq(jobParts.supply, 'shop')))
  const unlinkedPartCosts: UnlinkedPartCost[] = parts
    .filter((p) => p.unitCostCents != null && p.unitCostCents > 0 && !linkedPartIds.has(p.id))
    .map((p) => {
      const quantity = Number(p.quantity) || 1
      return { partId: p.id, description: p.description, quantity, unitCostCents: p.unitCostCents as number, costCents: Math.round((p.unitCostCents as number) * quantity) }
    })
  return {
    items, ...rollUpJobExpenses(items),
    unlinkedPartCosts, unlinkedPartCostCents: unlinkedPartCosts.reduce((s, p) => s + p.costCents, 0),
  }
}

// ── Link an existing receipt (no re-upload, no second expense) ───────────────────────────────────────
export interface LinkableReceipt {
  id: string; vendor: string | null; description: string | null; receiptDate: string | null
  totalCents: number | null; status: string; paymentLabel: string
  invoiceNumber: string | null; orderNumber: string | null
  purchase: AllocationSummary
}
/**
 * Recent, non-rejected receipts a manager can attach to a job — newest first, optionally filtered by vendor /
 * invoice # / order # / description / notes. Fully-allocated purchases are left out (nothing left to assign).
 */
export async function listLinkableReceipts(q = '', limit = 20): Promise<LinkableReceipt[]> {
  const db = getDb()
  const conds = [ne(businessReceipts.status, 'rejected')]
  for (const t of searchTokens(q)) {
    const like = `%${t}%`
    conds.push(sql`(lower(coalesce(${businessReceipts.vendor}, '')) like ${like}
      or lower(coalesce(${businessReceipts.invoiceNumber}, '')) like ${like}
      or lower(coalesce(${businessReceipts.orderNumber}, '')) like ${like}
      or lower(coalesce(${businessReceipts.description}, '')) like ${like}
      or lower(coalesce(${businessReceipts.memo}, '')) like ${like}
      or lower(coalesce(${businessReceipts.filingNote}, '')) like ${like})`)
  }
  const rows = await db.select().from(businessReceipts).where(and(...conds)).orderBy(desc(businessReceipts.createdAt)).limit(80)
  if (rows.length === 0) return []
  const allocs = await db.select().from(expenseAllocations)
    .where(and(inArray(expenseAllocations.receiptId, rows.map((r) => r.id)), eq(expenseAllocations.status, 'active')))
  const out: LinkableReceipt[] = []
  for (const r of rows) {
    const purchase = summarizeAllocations(r.totalCents, allocs.filter((a) => a.receiptId === r.id))
    if (purchase.state === 'full' || purchase.state === 'over' || purchase.whole) continue
    out.push({
      id: r.id, vendor: r.vendor, description: r.description, receiptDate: r.receiptDate, totalCents: r.totalCents,
      status: r.status, paymentLabel: receiptPaymentLabel(r), invoiceNumber: r.invoiceNumber, orderNumber: r.orderNumber, purchase,
    })
    if (out.length >= limit) break
  }
  return out
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────────
export interface AllocateInput {
  receiptId: string
  target: AllocationTarget
  serviceOrderId?: string | null
  amountCents: number | null      // null = the whole purchase
  jobPartId?: string | null
  note?: string | null
}
export interface AllocateResult { ok: boolean; error?: string; id?: string; already?: boolean }

async function validateTarget(input: AllocateInput): Promise<string | null> {
  const db = getDb()
  if (input.target === 'job') {
    if (!isUuid(input.serviceOrderId)) return 'Choose a job.'
    const [o] = await db.select({ id: serviceOrders.id }).from(serviceOrders).where(eq(serviceOrders.id, input.serviceOrderId)).limit(1)
    if (!o) return 'That job no longer exists.'
    if (input.jobPartId) {
      if (!isUuid(input.jobPartId)) return 'That part is not on this job.'
      const [p] = await db.select({ id: jobParts.id }).from(jobParts)
        .where(and(eq(jobParts.id, input.jobPartId), eq(jobParts.serviceOrderId, input.serviceOrderId))).limit(1)
      if (!p) return 'That part is not on this job.'
    }
  } else if (input.serviceOrderId || input.jobPartId) {
    return 'An overhead assignment cannot name a job.'
  }
  return null
}

const describe = (a: { target: string; serviceOrderId: string | null; amountCents: number | null }) =>
  `${a.target === 'job' ? `job ${a.serviceOrderId}` : 'overhead'} · ${a.amountCents == null ? 'whole purchase' : `$${(a.amountCents / 100).toFixed(2)}`}`

/**
 * Point a purchase (or part of it) at a job or at overhead. Never creates an expense. Guarantees:
 *   - the receipt exists and is not rejected;
 *   - active allocations can never exceed the purchase total (pure checkNewAllocation + a post-insert
 *     re-check that backs out a concurrent over-allocation);
 *   - idempotent per (purchase, job): a double-tap / retry returns the existing link (already=true).
 * Appends an 'allocated' entry to the receipt's audit trail.
 */
export async function allocateReceipt(input: AllocateInput, actor: Actor): Promise<AllocateResult> {
  const db = getDb()
  if (!isUuid(input.receiptId)) return { ok: false, error: 'Receipt not found.' }
  const receipt = await getReceipt(input.receiptId)
  if (!receipt) return { ok: false, error: 'Receipt not found.' }
  if (receipt.status === 'rejected') return { ok: false, error: 'A rejected receipt cannot be assigned. Reopen it first.' }
  const targetErr = await validateTarget(input)
  if (targetErr) return { ok: false, error: targetErr }

  const existing = await activeAllocationsForReceipt(receipt.id)
  const same = existing.find((a) => a.target === input.target && (a.serviceOrderId ?? null) === (input.target === 'job' ? input.serviceOrderId ?? null : null))
  if (same) {
    if (same.amountCents === input.amountCents) return { ok: true, id: same.id, already: true }
    return { ok: false, error: 'This purchase is already assigned here. Change the amount on the existing assignment instead.' }
  }
  const check = checkNewAllocation(receipt.totalCents, existing, input.amountCents)
  if (!check.ok) return { ok: false, error: check.error }

  const values = {
    receiptId: receipt.id, target: input.target,
    serviceOrderId: input.target === 'job' ? (input.serviceOrderId as string) : null,
    jobPartId: input.target === 'job' ? (input.jobPartId ?? null) : null,
    amountCents: input.amountCents, note: input.note?.trim() || null,
    createdBy: actor.name, createdByKey: actor.key,
  }
  let id: string
  try {
    const [row] = await db.insert(expenseAllocations).values(values).returning({ id: expenseAllocations.id })
    id = row.id
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost a race with an identical request → return the row that won (idempotent), or explain.
      const now = await activeAllocationsForReceipt(receipt.id)
      const won = now.find((a) => a.target === input.target && (a.serviceOrderId ?? null) === values.serviceOrderId)
      if (won && won.amountCents === input.amountCents) return { ok: true, id: won.id, already: true }
      return { ok: false, error: 'This purchase was just assigned by someone else — refresh and try again.' }
    }
    throw err
  }
  // Post-insert re-check (the driver has no interactive transaction): if a concurrent split pushed the
  // purchase over its total, back THIS allocation out rather than leave an over-allocated purchase.
  const after = summarizeAllocations(receipt.totalCents, await activeAllocationsForReceipt(receipt.id))
  if (after.state === 'over') {
    await db.update(expenseAllocations).set({ status: 'removed', removedBy: 'system', removedAt: new Date(), removedReason: 'Backed out: would exceed the purchase total.' })
      .where(eq(expenseAllocations.id, id))
    return { ok: false, error: 'That would assign more than the purchase total — refresh and try again.' }
  }
  await appendReceiptAudit(receipt.id, auditEntry('allocated', actor.name, undefined, describe(values)))
  return { ok: true, id }
}

/** Soft-remove an allocation (the purchase itself is untouched). Idempotent. Audited on the receipt. */
export async function removeAllocation(allocationId: string, reason: string | null, actor: Actor): Promise<{ ok: boolean; error?: string }> {
  if (!isUuid(allocationId)) return { ok: false, error: 'Assignment not found.' }
  const db = getDb()
  const [a] = await db.select().from(expenseAllocations).where(eq(expenseAllocations.id, allocationId)).limit(1)
  if (!a) return { ok: false, error: 'Assignment not found.' }
  if (a.status === 'removed') return { ok: true }
  const done = await db.update(expenseAllocations)
    .set({ status: 'removed', removedBy: actor.name, removedAt: new Date(), removedReason: reason?.trim() || null })
    .where(and(eq(expenseAllocations.id, allocationId), eq(expenseAllocations.status, 'active'))).returning({ id: expenseAllocations.id })
  if (done.length > 0) await appendReceiptAudit(a.receiptId, auditEntry('allocation_removed', actor.name, undefined, [describe(a), reason?.trim()].filter(Boolean).join(' — ')))
  return { ok: true }
}

export interface ChangeAllocationInput {
  target?: AllocationTarget
  serviceOrderId?: string | null
  amountCents?: number | null     // undefined = keep; null = whole purchase
  jobPartId?: string | null       // undefined = keep (cleared automatically when the job changes)
  note?: string | null
}
/**
 * Correct or reassign an allocation: move it to another job / overhead, change its amount (whole ↔ split), or
 * tie it to a part line. The old row is kept as 'removed' with replaced_by → the new row, and the receipt's
 * audit trail records before → after + the reason. If the replacement is not valid (e.g. it would exceed the
 * purchase total) the original is restored untouched.
 */
export async function changeAllocation(allocationId: string, change: ChangeAllocationInput, reason: string | null, actor: Actor): Promise<AllocateResult> {
  if (!isUuid(allocationId)) return { ok: false, error: 'Assignment not found.' }
  const db = getDb()
  const [old] = await db.select().from(expenseAllocations).where(eq(expenseAllocations.id, allocationId)).limit(1)
  if (!old || old.status !== 'active') return { ok: false, error: 'That assignment was already changed — refresh and try again.' }
  const target = (change.target ?? old.target) as AllocationTarget
  const serviceOrderId = target === 'job' ? (change.serviceOrderId !== undefined ? change.serviceOrderId : old.serviceOrderId) : null
  const movedJob = serviceOrderId !== old.serviceOrderId
  const next: AllocateInput = {
    receiptId: old.receiptId, target, serviceOrderId,
    amountCents: change.amountCents !== undefined ? change.amountCents : old.amountCents,
    jobPartId: target !== 'job' ? null : change.jobPartId !== undefined ? change.jobPartId : movedJob ? null : old.jobPartId,
    note: change.note !== undefined ? change.note : old.note,
  }
  if (next.target === old.target && next.serviceOrderId === old.serviceOrderId && next.amountCents === old.amountCents
    && (next.jobPartId ?? null) === old.jobPartId && (next.note ?? null) === old.note) return { ok: true, id: old.id, already: true }

  // Retire the old row first (the partial unique indexes allow only one active whole / per-job row).
  const retired = await db.update(expenseAllocations)
    .set({ status: 'removed', removedBy: actor.name, removedAt: new Date(), removedReason: reason?.trim() || 'Changed' })
    .where(and(eq(expenseAllocations.id, old.id), eq(expenseAllocations.status, 'active'))).returning({ id: expenseAllocations.id })
  if (retired.length === 0) return { ok: false, error: 'That assignment was already changed — refresh and try again.' }
  const restore = () => db.update(expenseAllocations)
    .set({ status: 'active', removedBy: null, removedAt: null, removedReason: null }).where(eq(expenseAllocations.id, old.id))
  let created: AllocateResult
  try { created = await allocateReceipt(next, actor) } catch (err) { await restore(); throw err }
  if (!created.ok || !created.id) { await restore(); return { ok: false, error: created.error ?? 'Could not change the assignment.' } }
  await db.update(expenseAllocations).set({ replacedBy: created.id }).where(eq(expenseAllocations.id, old.id))
  await appendReceiptAudit(old.receiptId, auditEntry('allocation_changed', actor.name,
    { allocation: { from: describe(old), to: describe({ target: next.target, serviceOrderId: next.serviceOrderId ?? null, amountCents: next.amountCents }) } }, reason?.trim() || null))
  return { ok: true, id: created.id }
}
