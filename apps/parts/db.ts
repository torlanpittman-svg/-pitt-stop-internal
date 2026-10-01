/**
 * Parts purchasing & tracking — data layer. Thin I/O over the pure logic in ./status.ts.
 * Numeric columns are normalized string→number at the boundary so callers work in plain numbers.
 */
import { getDb } from '@/platform/db'
import { and, eq, inArray } from 'drizzle-orm'
import { jobParts } from './schema'
import { jobServices, jobLineItems } from '@/apps/workflow/schema'
import { getOrCreateEstimate, addService, addLine, recomputeEstimate, flagQbSyncNeededIfInvoiced } from '@/apps/workflow/estimate-db'
import {
  applyReceipt,
  applyReturn,
  canMarkOrdered,
  isPartWaiting,
  outstandingQuantity,
  type PartStatus,
} from './status'

export interface Part {
  id: string
  serviceOrderId: string
  jobLineItemId: string | null
  description: string
  partNumber: string | null
  brand: string | null
  supplier: string | null
  provider: string | null
  providerRef: string | null
  quantity: number
  unitCostCents: number | null
  sellPriceCents: number | null
  status: PartStatus
  supplierOrderNumber: string | null
  orderedAt: string | null
  expectedArrival: string | null
  receivedQuantity: number
  isCore: boolean
  coreCreditCents: number | null
  returnedQuantity: number
  returnCreditCents: number | null
  notes: string | null
  outstandingQuantity: number
  waiting: boolean
  /** True when this part is linked to a LIVE estimate/invoice line (so it is billed, once). */
  billed: boolean
  /** True when a return and/or core credit is still outstanding (not fully credited). */
  creditOutstanding: boolean
  createdAt: string
  updatedAt: string
}

type Row = typeof jobParts.$inferSelect

function num(v: string | number | null): number {
  if (v == null) return 0
  return typeof v === 'number' ? v : Number(v)
}

function toPart(r: Row, billed = false): Part {
  const quantity = num(r.quantity)
  const receivedQuantity = num(r.receivedQuantity)
  const status = r.status as PartStatus
  const base = { status, quantity, receivedQuantity, returnedQuantity: num(r.returnedQuantity) }
  return {
    id: r.id,
    serviceOrderId: r.serviceOrderId,
    jobLineItemId: r.jobLineItemId,
    description: r.description,
    partNumber: r.partNumber,
    brand: r.brand,
    supplier: r.supplier,
    provider: r.provider,
    providerRef: r.providerRef,
    quantity,
    unitCostCents: r.unitCostCents,
    sellPriceCents: r.sellPriceCents,
    status,
    supplierOrderNumber: r.supplierOrderNumber,
    orderedAt: r.orderedAt ? r.orderedAt.toISOString() : null,
    expectedArrival: r.expectedArrival,
    receivedQuantity,
    isCore: r.isCore,
    coreCreditCents: r.coreCreditCents,
    returnedQuantity: num(r.returnedQuantity),
    returnCreditCents: r.returnCreditCents,
    notes: r.notes,
    outstandingQuantity: outstandingQuantity(base),
    waiting: isPartWaiting(status),
    billed,
    creditOutstanding:
      (r.isCore && !((r.coreCreditCents ?? 0) > 0)) ||
      (num(r.returnedQuantity) > 0 && !((r.returnCreditCents ?? 0) > 0)),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listPartsForOrder(serviceOrderId: string): Promise<Part[]> {
  const db = getDb()
  // Left join so `billed` reflects a LIVE line only — a part whose line was later deleted reads
  // unbilled again (so it can be re-billed; no silently-missing charge).
  const rows = await db
    .select({ part: jobParts, lineId: jobLineItems.id })
    .from(jobParts)
    .leftJoin(jobLineItems, eq(jobLineItems.id, jobParts.jobLineItemId))
    .where(eq(jobParts.serviceOrderId, serviceOrderId))
    .orderBy(jobParts.createdAt)
  return rows.map((r) => toPart(r.part, r.lineId != null))
}

async function getRow(partId: string): Promise<Row | null> {
  const db = getDb()
  const [row] = await db.select().from(jobParts).where(eq(jobParts.id, partId)).limit(1)
  return row ?? null
}

export interface AddPartInput {
  serviceOrderId: string
  description: string
  partNumber?: string | null
  brand?: string | null
  supplier?: string | null
  quantity?: number
  /** Manager-only; callers strip these for non-managers. */
  unitCostCents?: number | null
  sellPriceCents?: number | null
  jobLineItemId?: string | null
  isCore?: boolean
  notes?: string | null
  actor?: string | null
}

/** Add a part. ALWAYS starts 'needed' — saving a part never implies it was ordered. */
export async function addPart(input: AddPartInput): Promise<Part> {
  const db = getDb()
  const [row] = await db
    .insert(jobParts)
    .values({
      serviceOrderId: input.serviceOrderId,
      description: input.description.trim(),
      partNumber: input.partNumber?.trim() || null,
      brand: input.brand?.trim() || null,
      supplier: input.supplier?.trim() || null,
      quantity: String(input.quantity ?? 1),
      unitCostCents: input.unitCostCents ?? null,
      sellPriceCents: input.sellPriceCents ?? null,
      jobLineItemId: input.jobLineItemId ?? null,
      isCore: input.isCore ?? false,
      notes: input.notes?.trim() || null,
      status: 'needed',
      createdBy: input.actor ?? null,
      updatedBy: input.actor ?? null,
    })
    .returning()
  return toPart(row)
}

export interface UpdatePartInput {
  description?: string
  partNumber?: string | null
  brand?: string | null
  supplier?: string | null
  quantity?: number
  unitCostCents?: number | null
  sellPriceCents?: number | null
  isCore?: boolean
  notes?: string | null
  actor?: string | null
}

/** Edit descriptive/pricing fields. Does not change status (use markOrdered/receive/return). */
export async function updatePart(partId: string, input: UpdatePartInput): Promise<Part | null> {
  const db = getDb()
  const set: Partial<Row> = { updatedAt: new Date(), updatedBy: input.actor ?? null }
  if (input.description !== undefined) set.description = input.description.trim()
  if (input.partNumber !== undefined) set.partNumber = input.partNumber?.trim() || null
  if (input.brand !== undefined) set.brand = input.brand?.trim() || null
  if (input.supplier !== undefined) set.supplier = input.supplier?.trim() || null
  if (input.quantity !== undefined) set.quantity = String(input.quantity)
  if (input.unitCostCents !== undefined) set.unitCostCents = input.unitCostCents
  if (input.sellPriceCents !== undefined) set.sellPriceCents = input.sellPriceCents
  if (input.isCore !== undefined) set.isCore = input.isCore
  if (input.notes !== undefined) set.notes = input.notes?.trim() || null
  const [row] = await db.update(jobParts).set(set).where(eq(jobParts.id, partId)).returning()
  return row ? toPart(row) : null
}

export interface MarkOrderedInput {
  supplier?: string | null
  supplierOrderNumber?: string | null
  expectedArrival?: string | null
  actor?: string | null
}

/**
 * Record that an order was placed. Fails closed unless a real order is evidenced
 * (supplier or confirmation number). Returns { error } instead of fabricating an 'ordered' state.
 */
export async function markOrdered(partId: string, input: MarkOrderedInput): Promise<{ ok: true; part: Part } | { ok: false; error: string }> {
  const current = await getRow(partId)
  if (!current) return { ok: false, error: 'Part not found.' }
  if (current.status === 'cancelled') return { ok: false, error: 'This part was cancelled.' }

  const supplier = input.supplier?.trim() || current.supplier
  const confirmation = input.supplierOrderNumber?.trim() || current.supplierOrderNumber
  if (!canMarkOrdered({ supplier, supplierOrderNumber: confirmation })) {
    return { ok: false, error: 'Record a supplier or an order/confirmation number before marking it ordered.' }
  }

  const db = getDb()
  const [row] = await db
    .update(jobParts)
    .set({
      status: 'ordered',
      supplier: supplier ?? null,
      supplierOrderNumber: confirmation ?? null,
      expectedArrival: input.expectedArrival ?? current.expectedArrival,
      orderedAt: current.orderedAt ?? new Date(),
      updatedAt: new Date(),
      updatedBy: input.actor ?? null,
    })
    .where(eq(jobParts.id, partId))
    .returning()
  return { ok: true, part: toPart(row) }
}

/** Receive a quantity (delta). Clamps and derives partially_received/received via pure logic. */
export async function receivePart(partId: string, deltaQty: number, actor?: string | null): Promise<{ ok: true; part: Part } | { ok: false; error: string }> {
  const current = await getRow(partId)
  if (!current) return { ok: false, error: 'Part not found.' }
  if (current.status === 'cancelled') return { ok: false, error: 'This part was cancelled.' }
  if (!(deltaQty > 0)) return { ok: false, error: 'Enter a quantity greater than zero.' }

  const next = applyReceipt(
    { status: current.status as PartStatus, quantity: num(current.quantity), receivedQuantity: num(current.receivedQuantity), returnedQuantity: num(current.returnedQuantity) },
    deltaQty
  )
  const db = getDb()
  const [row] = await db
    .update(jobParts)
    .set({ receivedQuantity: String(next.receivedQuantity), status: next.status, updatedAt: new Date(), updatedBy: actor ?? null })
    .where(eq(jobParts.id, partId))
    .returning()
  return { ok: true, part: toPart(row) }
}

export interface ReturnInput {
  returnQty: number
  returnCreditCents?: number | null
  isCore?: boolean
  coreCreditCents?: number | null
  actor?: string | null
}

/** Record a return and/or core credit (accumulates; manager-only credit amounts). */
export async function recordReturn(partId: string, input: ReturnInput): Promise<{ ok: true; part: Part } | { ok: false; error: string }> {
  const current = await getRow(partId)
  if (!current) return { ok: false, error: 'Part not found.' }

  const next = applyReturn(
    { status: current.status as PartStatus, quantity: num(current.quantity), receivedQuantity: num(current.receivedQuantity), returnedQuantity: num(current.returnedQuantity) },
    input.returnQty
  )
  const db = getDb()
  const addedCredit = input.returnCreditCents ?? 0
  const addedCore = input.coreCreditCents ?? 0
  const [row] = await db
    .update(jobParts)
    .set({
      returnedQuantity: String(next.returnedQuantity),
      returnCreditCents: addedCredit ? (current.returnCreditCents ?? 0) + addedCredit : current.returnCreditCents,
      isCore: input.isCore ?? current.isCore,
      coreCreditCents: addedCore ? (current.coreCreditCents ?? 0) + addedCore : current.coreCreditCents,
      updatedAt: new Date(),
      updatedBy: input.actor ?? null,
    })
    .where(eq(jobParts.id, partId))
    .returning()
  return { ok: true, part: toPart(row) }
}

export async function cancelPart(partId: string, actor?: string | null): Promise<Part | null> {
  const db = getDb()
  const [row] = await db
    .update(jobParts)
    .set({ status: 'cancelled', updatedAt: new Date(), updatedBy: actor ?? null })
    .where(eq(jobParts.id, partId))
    .returning()
  return row ? toPart(row) : null
}

const PARTS_SERVICE_TITLE = 'Parts'

/**
 * Explicitly bill a tracked part: create ONE estimate/invoice line for it via the authoritative
 * estimate path, and link the part to that line. Idempotent — if the part is already linked to a
 * live line it is not billed again (no duplicate charge). Requires a sell price (no $0/missing
 * charge). If the order already has a QuickBooks invoice, it is flagged for re-sync so the new line
 * isn't silently missed.
 */
export async function billPart(partId: string, actor?: string | null): Promise<{ ok: true; part: Part } | { ok: false; error: string }> {
  const db = getDb()
  const current = await getRow(partId)
  if (!current) return { ok: false, error: 'Part not found.' }
  if (current.status === 'cancelled') return { ok: false, error: 'This part was cancelled.' }

  // Already billed to a LIVE line → no-op (prevents duplicate billing).
  if (current.jobLineItemId) {
    const [existing] = await db.select({ id: jobLineItems.id }).from(jobLineItems).where(eq(jobLineItems.id, current.jobLineItemId)).limit(1)
    if (existing) {
      const [row] = await db.select().from(jobParts).where(eq(jobParts.id, partId)).limit(1)
      return { ok: true, part: toPart(row, true) }
    }
  }

  if (!(current.sellPriceCents != null && current.sellPriceCents > 0)) {
    return { ok: false, error: 'Set a sell price before adding this part to the invoice.' }
  }

  const estimate = await getOrCreateEstimate(current.serviceOrderId, actor ?? null)
  // Reuse a single "Parts" service bucket per estimate so part lines stay grouped.
  const [svc] = await db
    .select({ id: jobServices.id })
    .from(jobServices)
    .where(and(eq(jobServices.jobEstimateId, estimate.id), eq(jobServices.title, PARTS_SERVICE_TITLE)))
    .limit(1)
  const serviceId = svc?.id ?? (await addService(estimate.id, PARTS_SERVICE_TITLE)).id

  const name = [current.description, current.partNumber ? `#${current.partNumber}` : null].filter(Boolean).join(' ')
  const line = await addLine(serviceId, {
    type: 'part',
    name,
    qty: num(current.quantity),
    costCents: current.unitCostCents ?? 0,
    priceCents: current.sellPriceCents,
    partNumber: current.partNumber,
    brand: current.brand,
    supplier: current.supplier,
    taxCategory: 'repair_parts',
  })
  await recomputeEstimate(estimate.id)
  await flagQbSyncNeededIfInvoiced(current.serviceOrderId, 'part added to invoice')

  const [row] = await db
    .update(jobParts)
    .set({ jobLineItemId: line.id, updatedAt: new Date(), updatedBy: actor ?? null })
    .where(eq(jobParts.id, partId))
    .returning()
  return { ok: true, part: toPart(row, true) }
}

/** Bulk: which of these orders have outstanding (waiting) parts? Drives the Work Board badge. */
export async function ordersWithWaitingParts(serviceOrderIds: string[]): Promise<Set<string>> {
  if (serviceOrderIds.length === 0) return new Set()
  const db = getDb()
  const rows = await db
    .select({ id: jobParts.serviceOrderId })
    .from(jobParts)
    .where(
      and(
        inArray(jobParts.serviceOrderId, serviceOrderIds),
        inArray(jobParts.status, ['needed', 'ordered', 'partially_received'])
      )
    )
  return new Set(rows.map((r) => r.id))
}
