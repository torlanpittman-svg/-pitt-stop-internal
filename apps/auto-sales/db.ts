/**
 * Auto-Sales B0 — read models + append-only writes over the canonical vehicle.
 * Facts only; no accounting policy. No money movement; no QBO/bank writes.
 */
import { and, desc, eq, ne, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { vehicles, serviceOrders } from '@/apps/workflow/schema'
import { inventoryVehicles, vehicleFinancialEvents, vehicleDocuments } from './schema'
import { autoSalesCutoverDate } from '@/apps/settings/db'
import { normalizeVIN, validateVIN, decodeVINFromNHTSA, type VINDecodeResult } from '@/apps/vehicle-entry/vin'
import { generateStockNumber } from './stock'
import { costRelevance, defaultCashflow, type EconomicCategory, type FinancialCompleteness } from './types'

const iso = (d: Date) => d.toISOString().slice(0, 10)

// ── Canonical-vehicle match/create (never a parallel identity) ──
async function findOrCreateVehicle(input: { vin?: string | null; year?: string | null; make?: string | null; model?: string | null; color?: string | null; vinRaw?: unknown }): Promise<string> {
  const db = getDb()
  const vin = input.vin ? normalizeVIN(input.vin) : null
  if (vin) {
    const [existing] = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, vin)).limit(1)
    if (existing) return existing.id
  }
  const [row] = await db.insert(vehicles).values({
    vin: vin ?? null, year: input.year ?? null, make: input.make ?? null, model: input.model ?? null,
    color: input.color ?? null, vinRaw: (input.vinRaw ?? null) as any,
  }).returning({ id: vehicles.id })
  return row.id
}

// ── VIN resolution (validate → reuse decoder → dedup → conflict → attach + PS stock) ──
export interface VinDecodePreview { ok: boolean; error?: string; decoded?: VINDecodeResult }
/** Validate + decode a VIN for the UI to preview (reuses the shared NHTSA decoder). */
export async function previewVinDecode(rawVin: string): Promise<VinDecodePreview> {
  const { valid, error } = validateVIN(rawVin || '')
  if (!valid) return { ok: false, error }
  try { return { ok: true, decoded: await decodeVINFromNHTSA(normalizeVIN(rawVin)) } }
  catch { return { ok: false, error: 'VIN lookup service unavailable — try again in a moment' } }
}

export type VinResolveStatus = 'ok' | 'invalid' | 'conflict' | 'duplicate' | 'not_found'
export interface VinResolveResult {
  status: VinResolveStatus; error?: string; decoded?: VINDecodeResult; stockNumber?: string
  existingYmm?: { year: string | null; make: string | null; model: string | null }   // for conflict
  duplicateInfo?: string                                                              // for duplicate
}
/**
 * Attach a full VIN to a (typically Needs-VIN) inventory vehicle. VIN is the strongest identity:
 *  - validate + decode (reuse shared decoder)
 *  - DEDUP: if the VIN already belongs to another canonical vehicle that is bound to a DIFFERENT
 *    inventory unit → 'duplicate' (owner must resolve). If it belongs to another canonical NOT bound
 *    to inventory (e.g. a prior detail-scan) → re-point this inventory to that canonical (merge) and
 *    delete the now-orphan record.
 *  - CONFLICT: decoded year/make/model materially differs from the current backfill → 'conflict'
 *    unless confirmConflict (never silently overwrite).
 *  - APPLY: set VIN + decoded attributes on the canonical, generate PS-{last4}, record evidence.
 *  Financial completeness is unchanged (identity resolved ≠ historical costs suddenly complete).
 */
export async function resolveVin(input: { inventoryVehicleId: string; rawVin: string; confirmConflict?: boolean; actor: string | null }): Promise<VinResolveResult> {
  const db = getDb()
  const { valid, error } = validateVIN(input.rawVin || '')
  if (!valid) return { status: 'invalid', error }
  const vin = normalizeVIN(input.rawVin)
  let decoded: VINDecodeResult
  try { decoded = await decodeVINFromNHTSA(vin) } catch { return { status: 'invalid', error: 'VIN lookup service unavailable — try again in a moment' } }

  const [row] = await db.select({ inv: inventoryVehicles, v: vehicles }).from(inventoryVehicles)
    .innerJoin(vehicles, eq(inventoryVehicles.vehicleId, vehicles.id)).where(eq(inventoryVehicles.id, input.inventoryVehicleId)).limit(1)
  if (!row) return { status: 'not_found', error: 'Inventory vehicle not found' }
  const currentCanonicalId = row.v.id

  // DEDUP — VIN uniqueness is the strongest check.
  const [vinOwner] = await db.select().from(vehicles).where(and(eq(vehicles.vin, vin), ne(vehicles.id, currentCanonicalId))).limit(1)
  let targetCanonicalId = currentCanonicalId
  let merging = false
  if (vinOwner) {
    const [boundInv] = await db.select({ id: inventoryVehicles.id, stock: inventoryVehicles.stockNumber }).from(inventoryVehicles).where(eq(inventoryVehicles.vehicleId, vinOwner.id)).limit(1)
    if (boundInv && boundInv.id !== input.inventoryVehicleId) {
      return { status: 'duplicate', decoded, duplicateInfo: `VIN ${vin} is already the identity of another inventory vehicle${boundInv.stock ? ` (${boundInv.stock})` : ''}. Two inventory units cannot share one VIN — resolve which is correct.` }
    }
    targetCanonicalId = vinOwner.id; merging = true   // VIN belongs to a non-inventory canonical → attach to it
  }

  // CONFLICT — decoded YMM vs the existing backfill (never silently overwrite).
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
  const conflict = (decoded.year && norm(decoded.year) !== norm(row.v.year) && row.v.year)
    || (decoded.make && norm(decoded.make) !== norm(row.v.make) && row.v.make)
    || (decoded.model && norm(decoded.model) !== norm(row.v.model) && row.v.model)
  if (conflict && !input.confirmConflict) {
    return { status: 'conflict', decoded, existingYmm: { year: row.v.year, make: row.v.make, model: row.v.model } }
  }

  // APPLY
  const attrs = {
    vin, year: decoded.year ?? row.v.year, make: decoded.make ?? row.v.make, model: decoded.model ?? row.v.model,
    bodyClass: decoded.bodyClass ?? row.v.bodyClass, vinRaw: decoded as any, updatedAt: new Date(),
  }
  await db.update(vehicles).set(attrs).where(eq(vehicles.id, targetCanonicalId))
  const stockNumber = await generateStockNumber(vin, input.inventoryVehicleId)
  const evidence = `VIN ${vin} entered/decoded ${new Date().toISOString().slice(0, 10)} → ${[decoded.year, decoded.make, decoded.model, decoded.trim].filter(Boolean).join(' ')}${merging ? ' · linked to existing canonical vehicle (dedup)' : ''}${conflict ? ' · YMM conflict confirmed by user' : ''}.`
  const set: Record<string, unknown> = { stockNumber, notes: [row.inv.notes, evidence].filter(Boolean).join(' | '), updatedAt: new Date() }
  if (merging) set.vehicleId = targetCanonicalId
  await db.update(inventoryVehicles).set(set).where(eq(inventoryVehicles.id, input.inventoryVehicleId))
  // If we merged onto another canonical, delete the now-orphan old canonical (only if unreferenced).
  if (merging && currentCanonicalId !== targetCanonicalId) {
    const so = await db.select({ id: serviceOrders.id }).from(serviceOrders).where(eq(serviceOrders.vehicleId, currentCanonicalId)).limit(1)
    const stillInv = await db.select({ id: inventoryVehicles.id }).from(inventoryVehicles).where(eq(inventoryVehicles.vehicleId, currentCanonicalId)).limit(1)
    if (so.length === 0 && stillInv.length === 0) await db.delete(vehicles).where(eq(vehicles.id, currentCanonicalId))
  }
  return { status: 'ok', decoded, stockNumber: stockNumber ?? undefined }
}

export interface AcquireInput {
  vin?: string | null; year?: string | null; make?: string | null; model?: string | null; color?: string | null; vinRaw?: unknown
  acquisitionCostCents: number; acquiredAt: string; acquisitionSource?: string; seller?: string
  paymentAccountRef?: string; floorPlanned?: boolean; floorPlanLender?: string
  origin?: 'quick_entry' | 'spreadsheet_backfill' | 'trade_in'
  completenessOverride?: FinancialCompleteness
  actor: string | null
}

/** Create the owned-inventory record + acquisition event (+ optional floor-plan draw). Returns the
 *  inventory_vehicle id. Completeness/cutover are set from facts; nothing historical is fabricated. */
export async function createAcquisition(input: AcquireInput): Promise<{ inventoryVehicleId: string; stockNumber: string | null }> {
  const db = getDb()
  const cutover = await autoSalesCutoverDate()
  const vehicleId = await findOrCreateVehicle(input)
  const stockNumber = await generateStockNumber(input.vin)
  const preCutover = input.acquiredAt < cutover
  const origin = input.origin ?? 'quick_entry'
  // Go-forward quick-entry (from cutover) = complete tracking; unresolved identity = needs_review;
  // historical backfill = historical_incomplete (acquisition known, prior recon unknown).
  const completeness: FinancialCompleteness = input.completenessOverride
    ?? (stockNumber == null ? 'needs_review' : origin === 'spreadsheet_backfill' || preCutover ? 'historical_incomplete' : 'complete')
  const trackingStart = preCutover ? cutover : input.acquiredAt

  const [inv] = await db.insert(inventoryVehicles).values({
    vehicleId, stockNumber, status: 'acquired',
    acquisitionSource: input.acquisitionSource ?? null, seller: input.seller ?? null, acquiredAt: input.acquiredAt,
    origin, preCutover, trackingStartDate: trackingStart, financialCompleteness: completeness, createdBy: input.actor,
  }).returning({ id: inventoryVehicles.id })

  await db.insert(vehicleFinancialEvents).values({
    inventoryVehicleId: inv.id, economicCategory: 'acquisition', cashflowCategory: defaultCashflow('acquisition'),
    amountCents: input.acquisitionCostCents, eventDate: input.acquiredAt, vendor: input.seller ?? null,
    paymentAccountRef: input.paymentAccountRef ?? 'unknown', status: 'verified', source: input.origin === 'spreadsheet_backfill' ? 'import' : 'manual',
    memo: 'Vehicle acquisition', createdBy: input.actor,
  })
  if (input.floorPlanned) {
    await db.insert(vehicleFinancialEvents).values({
      inventoryVehicleId: inv.id, economicCategory: 'floorplan_draw', cashflowCategory: defaultCashflow('floorplan_draw'),
      amountCents: input.acquisitionCostCents, eventDate: input.acquiredAt, vendor: input.floorPlanLender ?? 'Floor plan',
      paymentAccountRef: '*5600', status: 'unverified', confidence: 'estimated', source: 'manual',
      memo: `Floor-plan draw (${input.floorPlanLender ?? 'lender'}) — unverified until B4 reconciliation`, createdBy: input.actor,
    })
  }
  return { inventoryVehicleId: inv.id, stockNumber }
}

export interface ExpenseInput {
  inventoryVehicleId: string; economicCategory: EconomicCategory; amountCents: number; eventDate: string
  vendor?: string; memo?: string; paymentAccountRef?: string; cashflowOverride?: string; actor: string | null
}
export async function addExpenseEvent(input: ExpenseInput): Promise<string> {
  const [row] = await getDb().insert(vehicleFinancialEvents).values({
    inventoryVehicleId: input.inventoryVehicleId, economicCategory: input.economicCategory,
    cashflowCategory: input.cashflowOverride ?? defaultCashflow(input.economicCategory),
    amountCents: input.amountCents, eventDate: input.eventDate, vendor: input.vendor ?? null, memo: input.memo ?? null,
    paymentAccountRef: input.paymentAccountRef ?? 'unknown', status: 'verified', source: 'manual', createdBy: input.actor,
  }).returning({ id: vehicleFinancialEvents.id })
  return row.id
}

/** Correction = append a reversal event linking the original. The original row is never rewritten;
 *  the summary nets both to zero. */
export async function reverseEvent(eventId: string, actor: string | null): Promise<void> {
  const db = getDb()
  const [orig] = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.id, eventId)).limit(1)
  if (!orig) return
  await db.insert(vehicleFinancialEvents).values({
    inventoryVehicleId: orig.inventoryVehicleId, economicCategory: 'adjustment', cashflowCategory: 'non_cash',
    amountCents: orig.amountCents, eventDate: iso(new Date()), reversesEventId: orig.id, status: 'verified', source: 'manual',
    memo: `Reversal of ${orig.economicCategory} (${(orig.memo ?? '').slice(0, 60)})`, createdBy: actor,
  })
}

// ── Factual summary (never a single "total cost basis" when incomplete) ──
export interface VehicleFinancialSummary {
  acquisitionCostCents: number
  verifiedAdditionalCents: number       // verified cost_add − verified cost_contra (returns/refunds/credits)
  unverifiedAdditionalCents: number
  knownInvestmentCents: number          // acquisition + verified additional (NOT called "total cost basis")
  sellingCostsCents: number             // commission etc — separate from vehicle investment
  proceedsCents: number                 // sale/deposit
  refundPendingCents: number            // economic reduction recognized, cash NOT yet received
  refundSettledCents: number
  cashRefundReceivedCents: number       // settled cash/card refunds only (vendor/store credits excluded)
  completeness: FinancialCompleteness
  historicalIncomplete: boolean
}
export function computeSummary(events: (typeof vehicleFinancialEvents.$inferSelect)[], completeness: FinancialCompleteness): VehicleFinancialSummary {
  // Exclude reversed pairs (append-only CORRECTION) from all math — distinct from a real-world return.
  const reversedTargets = new Set(events.filter((e) => e.reversesEventId).map((e) => e.reversesEventId as string))
  const excluded = (e: typeof events[number]) => e.status === 'void' || Boolean(e.reversesEventId) || reversedTargets.has(e.id)

  let acq = 0, addV = 0, contraV = 0, addU = 0, contraU = 0, selling = 0, proceeds = 0
  let refundPending = 0, refundSettled = 0, cashReceived = 0
  for (const e of events) {
    if (excluded(e)) continue
    const rel = costRelevance(e.economicCategory as EconomicCategory)
    const verified = e.status === 'verified' || e.status === 'reconciled'
    // Refund lifecycle (cash tracking) — independent of the economic cost reduction below.
    if (e.refundStatus) {
      if (e.refundStatus === 'settled') { refundSettled += e.amountCents; if (e.refundMethod === 'cash' || e.refundMethod === 'card') cashReceived += e.amountCents }
      else refundPending += e.amountCents
    }
    if (e.economicCategory === 'acquisition') { acq += e.amountCents; continue }
    if (rel === 'cost_add') { verified ? (addV += e.amountCents) : (addU += e.amountCents) }
    else if (rel === 'cost_contra') { verified ? (contraV += e.amountCents) : (contraU += e.amountCents) }
    else if (rel === 'selling_cost' && verified) { selling += e.amountCents }
    else if (rel === 'proceeds' && verified) { proceeds += e.amountCents }
  }
  return {
    acquisitionCostCents: acq, verifiedAdditionalCents: addV - contraV, unverifiedAdditionalCents: addU - contraU,
    knownInvestmentCents: acq + (addV - contraV), sellingCostsCents: selling, proceedsCents: proceeds,
    refundPendingCents: refundPending, refundSettledCents: refundSettled, cashRefundReceivedCents: cashReceived,
    completeness, historicalIncomplete: completeness === 'historical_incomplete' || completeness === 'partially_reconstructed' || completeness === 'needs_review',
  }
}

// ── Indicative result + closeout completeness (completeness-aware; never definitive when incomplete) ──
export interface VehicleResult {
  sold: boolean
  indicativeProfitCents: number | null
  resultLabel: string                   // 'Indicative gross profit' | 'Indicative tracked margin'
  confidence: 'normal' | 'limited'
  closeoutStatus: 'not_sold' | 'sale_pending' | 'sold_complete' | 'sold_incomplete'
  unresolved: string[]                  // outstanding closeout items
}
export function computeResult(inv: typeof inventoryVehicles.$inferSelect, s: VehicleFinancialSummary): VehicleResult {
  const sold = inv.status === 'sold' || inv.status === 'delivered' || inv.status === 'wholesaled'
  const salePending = inv.status === 'sale_pending'
  const indicative = sold ? s.proceedsCents - s.knownInvestmentCents - s.sellingCostsCents : null
  const complete = s.completeness === 'complete'
  // Unresolved closeout items keep a sold vehicle at "closeout incomplete".
  const unresolved: string[] = []
  if (inv.payoffStatus === 'open') unresolved.push(`floor-plan/loan payoff outstanding${inv.payoffKnownCents ? ` (~$${(inv.payoffKnownCents / 100).toLocaleString()})` : ''}`)
  if (inv.proceedsReceived === 'no') unresolved.push('sale proceeds not yet received')
  if (inv.titleOutstanding) unresolved.push('title work outstanding')
  if (s.refundPendingCents > 0) unresolved.push(`refund pending ($${(s.refundPendingCents / 100).toLocaleString()})`)
  const closeoutStatus = !sold && !salePending ? 'not_sold' : salePending ? 'sale_pending' : unresolved.length ? 'sold_incomplete' : 'sold_complete'
  return {
    sold, indicativeProfitCents: indicative,
    resultLabel: complete ? 'Indicative gross profit' : 'Indicative tracked margin',
    confidence: complete ? 'normal' : 'limited', closeoutStatus, unresolved,
  }
}

// ── Returns / refunds / credits (append-only; link to the original expense; partial supported) ──
export interface ReturnableExpense { id: string; economicCategory: string; vendor: string | null; eventDate: string; amountCents: number; returnedCents: number; remainingCents: number }
/** Expenses eligible to return (verified cost_add events) with how much remains returnable. */
export async function getReturnableExpenses(inventoryVehicleId: string): Promise<ReturnableExpense[]> {
  const db = getDb()
  const events = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.inventoryVehicleId, inventoryVehicleId))
  const reversedTargets = new Set(events.filter((e) => e.reversesEventId).map((e) => e.reversesEventId))
  const active = events.filter((e) => e.status !== 'void' && !e.reversesEventId && !reversedTargets.has(e.id))
  const returnsByOriginal = new Map<string, number>()
  for (const e of active) if (e.originalEventId && costRelevance(e.economicCategory as EconomicCategory) === 'cost_contra') returnsByOriginal.set(e.originalEventId, (returnsByOriginal.get(e.originalEventId) ?? 0) + e.amountCents)
  return active.filter((e) => costRelevance(e.economicCategory as EconomicCategory) === 'cost_add')
    .map((e) => { const returned = returnsByOriginal.get(e.id) ?? 0; return { id: e.id, economicCategory: e.economicCategory, vendor: e.vendor, eventDate: e.eventDate, amountCents: e.amountCents, returnedCents: returned, remainingCents: e.amountCents - returned } })
    .filter((e) => e.remainingCents > 0 || e.returnedCents > 0)
}

export interface ReturnInput {
  inventoryVehicleId: string; originalEventId: string; econ: EconomicCategory; refundMethod: string; cash: boolean
  amountCents: number; eventDate: string; refundStatus: 'expected' | 'pending' | 'settled'; destinationAccount?: string
  memo?: string; allowExceed?: boolean; actor: string | null
}
/** Append a return/refund/credit event linked to the original expense. Partial supported. Guards against
 *  returning more than economically remains unless allowExceed is set (audited via memo). Never deletes. */
export async function addReturnRefund(input: ReturnInput): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const [orig] = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.id, input.originalEventId)).limit(1)
  if (!orig) return { ok: false, error: 'Original expense not found' }
  const returnable = await getReturnableExpenses(input.inventoryVehicleId)
  const remaining = returnable.find((r) => r.id === input.originalEventId)?.remainingCents ?? 0
  if (input.amountCents > remaining && !input.allowExceed) return { ok: false, error: `Exceeds remaining ($${(remaining / 100).toFixed(2)}). Confirm an explicit over-return to proceed.` }
  // Cash/card refunds start pending (no cash yet); vendor/store credits settle immediately as NON-cash.
  const cashflow = input.cash ? (input.refundStatus === 'settled' ? 'cash_inflow' : 'pending') : 'non_cash'
  await db.insert(vehicleFinancialEvents).values({
    inventoryVehicleId: input.inventoryVehicleId, economicCategory: input.econ, cashflowCategory: cashflow,
    amountCents: input.amountCents, eventDate: input.eventDate, vendor: orig.vendor, originalEventId: orig.id,
    refundStatus: input.refundStatus, refundMethod: input.refundMethod, refundDestinationAccount: input.destinationAccount ?? null,
    settledAt: input.refundStatus === 'settled' ? input.eventDate : null, status: 'verified', source: 'manual',
    memo: input.memo ?? `${input.allowExceed && input.amountCents > remaining ? 'OVER-RETURN — ' : ''}${input.refundMethod} against ${orig.economicCategory}`, createdBy: input.actor,
  })
  return { ok: true }
}

/** Move a pending cash/card refund to settled (cash received). Lifecycle transition on the same event
 *  (not a destructive amount edit). B3 will later reconcile it against the actual bank/card credit. */
export async function settleRefund(eventId: string, settledDate: string, actor: string | null): Promise<void> {
  const db = getDb()
  const [e] = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.id, eventId)).limit(1)
  if (!e || !e.refundStatus || e.refundStatus === 'settled') return
  await db.update(vehicleFinancialEvents).set({
    refundStatus: 'settled', settledAt: settledDate,
    cashflowCategory: (e.refundMethod === 'cash' || e.refundMethod === 'card') ? 'cash_inflow' : 'non_cash',
  }).where(eq(vehicleFinancialEvents.id, eventId))
}

// ── Sale / closeout ──
export interface SaleInput {
  inventoryVehicleId: string; saleDate: string; salePriceCents: number; saleType?: 'retail' | 'wholesale'
  proceedsAccount?: string; buyerRef?: string; commissionCents?: number; payoffKnownCents?: number
  payoffStatus?: 'open' | 'paid' | 'unknown' | 'none'; titleOutstanding?: boolean; proceedsReceived?: 'yes' | 'no' | 'unknown'
  markDelivered?: boolean; notes?: string; actor: string | null
}
/** Record a sale: a sale (proceeds) event, optional commission (selling cost) + known payoff (financing)
 *  events, and the closeout facts on the vehicle. Status → sale_pending/sold/delivered. Does NOT feed
 *  *5600 unencumbered or company Safe-to-Spend. Manually-known payoff is captured, not reconciled (B4). */
export async function sellVehicle(input: SaleInput): Promise<void> {
  const db = getDb()
  await db.insert(vehicleFinancialEvents).values({
    inventoryVehicleId: input.inventoryVehicleId, economicCategory: 'sale', cashflowCategory: input.proceedsReceived === 'yes' ? 'cash_inflow' : 'pending',
    amountCents: input.salePriceCents, eventDate: input.saleDate, vendor: input.buyerRef ?? null, paymentAccountRef: input.proceedsAccount ?? 'unknown',
    status: 'verified', source: 'manual', memo: `Vehicle sale (${input.saleType ?? 'retail'})`, createdBy: input.actor,
  })
  if (input.commissionCents && input.commissionCents > 0) await db.insert(vehicleFinancialEvents).values({
    inventoryVehicleId: input.inventoryVehicleId, economicCategory: 'commission', cashflowCategory: 'cash_outflow',
    amountCents: input.commissionCents, eventDate: input.saleDate, status: 'verified', source: 'manual', memo: 'Selling commission/fee', createdBy: input.actor,
  })
  if (input.payoffKnownCents && input.payoffKnownCents > 0) await db.insert(vehicleFinancialEvents).values({
    inventoryVehicleId: input.inventoryVehicleId, economicCategory: 'financing_settlement', cashflowCategory: 'financing_repayment',
    amountCents: input.payoffKnownCents, eventDate: input.saleDate, paymentAccountRef: '*5600',
    status: input.payoffStatus === 'paid' ? 'verified' : 'unverified', confidence: 'estimated', source: 'manual',
    memo: `Manually-known payoff (${input.payoffStatus ?? 'unknown'}) — not reconciled to Extraco until B4`, createdBy: input.actor,
  })
  const status = input.markDelivered ? 'delivered' : 'sold'
  await db.update(inventoryVehicles).set({
    status, disposition: input.saleType ?? 'retail', soldAt: input.saleDate, deliveredAt: input.markDelivered ? input.saleDate : null,
    salePriceCents: input.salePriceCents, saleType: input.saleType ?? 'retail', proceedsAccount: input.proceedsAccount ?? null, buyerRef: input.buyerRef ?? null,
    payoffKnownCents: input.payoffKnownCents ?? null, payoffStatus: input.payoffStatus ?? 'unknown',
    proceedsReceived: input.proceedsReceived ?? 'unknown', titleOutstanding: input.titleOutstanding ?? false, closeoutNotes: input.notes ?? null,
    updatedAt: new Date(),
  }).where(eq(inventoryVehicles.id, input.inventoryVehicleId))
}

/** Resolve outstanding closeout items (proceeds received / payoff paid / title done / delivered). */
export async function updateCloseout(input: { inventoryVehicleId: string; proceedsReceived?: 'yes' | 'no' | 'unknown'; payoffStatus?: 'open' | 'paid' | 'unknown' | 'none'; titleOutstanding?: boolean; markDelivered?: boolean; actor: string | null }): Promise<void> {
  const db = getDb()
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (input.proceedsReceived) set.proceedsReceived = input.proceedsReceived
  if (input.payoffStatus) set.payoffStatus = input.payoffStatus
  if (input.titleOutstanding !== undefined) set.titleOutstanding = input.titleOutstanding
  if (input.markDelivered) { set.status = 'delivered'; set.deliveredAt = iso(new Date()) }
  await db.update(inventoryVehicles).set(set).where(eq(inventoryVehicles.id, input.inventoryVehicleId))
}

export interface InventoryRow {
  id: string; stockNumber: string | null; vin: string | null; year: string | null; make: string | null; model: string | null; color: string | null
  status: string; acquiredAt: string | null; daysOnLot: number | null; completeness: FinancialCompleteness; summary: VehicleFinancialSummary; result: VehicleResult
}
export async function getInventoryList(): Promise<InventoryRow[]> {
  const db = getDb()
  const rows = await db.select({ inv: inventoryVehicles, v: vehicles }).from(inventoryVehicles)
    .innerJoin(vehicles, eq(inventoryVehicles.vehicleId, vehicles.id))
    .orderBy(desc(inventoryVehicles.createdAt))
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.inv.id)
  const events = await db.select().from(vehicleFinancialEvents).where(inArray(vehicleFinancialEvents.inventoryVehicleId, ids))
  const byVeh = new Map<string, (typeof events)>()
  for (const e of events) { const a = byVeh.get(e.inventoryVehicleId) ?? []; a.push(e); byVeh.set(e.inventoryVehicleId, a) }
  const today = new Date()
  return rows.map(({ inv, v }) => {
    const summary = computeSummary(byVeh.get(inv.id) ?? [], inv.financialCompleteness as FinancialCompleteness)
    return {
      id: inv.id, stockNumber: inv.stockNumber, vin: v.vin, year: v.year, make: v.make, model: v.model, color: v.color,
      status: inv.status, acquiredAt: inv.acquiredAt,
      daysOnLot: inv.acquiredAt ? Math.max(0, Math.round((today.getTime() - new Date(inv.acquiredAt + 'T00:00:00Z').getTime()) / 86400_000)) : null,
      completeness: inv.financialCompleteness as FinancialCompleteness, summary, result: computeResult(inv, summary),
    }
  })
}

export interface VehicleFolder {
  inv: typeof inventoryVehicles.$inferSelect; vehicle: typeof vehicles.$inferSelect
  events: (typeof vehicleFinancialEvents.$inferSelect)[]; summary: VehicleFinancialSummary; result: VehicleResult
  returnable: ReturnableExpense[]; daysOnLot: number | null
  /** eventId → receipt attachment (ordinary-sensitivity docs only get a viewable url). */
  attachments: Record<string, { documentId: string; url: string | null; docType: string }>
}
export async function getVehicleFolder(id: string): Promise<VehicleFolder | null> {
  const db = getDb()
  const [row] = await db.select({ inv: inventoryVehicles, v: vehicles }).from(inventoryVehicles)
    .innerJoin(vehicles, eq(inventoryVehicles.vehicleId, vehicles.id)).where(eq(inventoryVehicles.id, id)).limit(1)
  if (!row) return null
  const events = await db.select().from(vehicleFinancialEvents)
    .where(eq(vehicleFinancialEvents.inventoryVehicleId, id)).orderBy(vehicleFinancialEvents.eventDate, vehicleFinancialEvents.createdAt)
  const daysOnLot = row.inv.acquiredAt ? Math.max(0, Math.round((Date.now() - new Date(row.inv.acquiredAt + 'T00:00:00Z').getTime()) / 86400_000)) : null
  const summary = computeSummary(events, row.inv.financialCompleteness as FinancialCompleteness)
  // Attachments: documents linked to this vehicle's events. Only ordinary docs expose a direct url;
  // sensitive docs (future titles/buyer paperwork) would resolve through a gated route instead.
  const docs = await db.select().from(vehicleDocuments).where(eq(vehicleDocuments.inventoryVehicleId, id))
  const attachments: VehicleFolder['attachments'] = {}
  for (const d of docs) if (d.linkedEventId) attachments[d.linkedEventId] = { documentId: d.id, url: d.sensitivity === 'ordinary' && d.storage === 'blob_public' ? d.storageRef : null, docType: d.docType }
  return { inv: row.inv, vehicle: row.v, events, summary, result: computeResult(row.inv, summary), returnable: await getReturnableExpenses(id), daysOnLot, attachments }
}

// ── B2: Receipt / document capture ──────────────────────────────────────────
export interface ReceiptDocInput {
  inventoryVehicleId: string; docType?: string; storage: 'blob_public' | 'none'; storageRef: string | null
  filename?: string; contentType?: string; imageHash: string; byteSize?: number
  aiStatus: 'extracted' | 'failed'; aiModel: string | null; aiRaw: unknown; aiExtracted: unknown; uploadedBy: string | null
}
/** A prior, non-deleted document with the same content hash — for Blob reuse + duplicate warning. */
export async function findDocumentByHash(hash: string): Promise<(typeof vehicleDocuments.$inferSelect) | null> {
  const [d] = await getDb().select().from(vehicleDocuments).where(eq(vehicleDocuments.imageHash, hash)).orderBy(desc(vehicleDocuments.createdAt)).limit(1)
  return d ?? null
}
/** Create the document row on scan (image preserved even if AI failed → never strands a receipt). */
export async function createReceiptDocument(input: ReceiptDocInput): Promise<string> {
  const [row] = await getDb().insert(vehicleDocuments).values({
    inventoryVehicleId: input.inventoryVehicleId, docType: input.docType ?? 'receipt', sensitivity: 'ordinary',
    storage: input.storage, storageRef: input.storageRef, filename: input.filename ?? null, contentType: input.contentType ?? null,
    imageHash: input.imageHash, byteSize: input.byteSize ?? null, aiStatus: input.aiStatus, aiModel: input.aiModel,
    aiRaw: input.aiRaw as any, aiExtracted: input.aiExtracted as any, uploadedBy: input.uploadedBy,
  }).returning({ id: vehicleDocuments.id })
  return row.id
}

export interface SaveReceiptInput {
  documentId: string; economicCategory: EconomicCategory; amountCents: number; eventDate: string
  vendor?: string; receiptTotalCents?: number; paymentAccountRef?: string; memo?: string
  isReturn?: boolean; originalEventId?: string; actor: string | null
}
/** Turn a verified receipt into a financial event and link it to the document. Append-only: a return
 *  creates a return/refund event referencing the original (never edits the original). The amount can be
 *  a PORTION of the receipt total (split); receiptTotalCents preserves the true total on the document. */
export async function saveReceipt(input: SaveReceiptInput): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  const db = getDb()
  const [doc] = await db.select().from(vehicleDocuments).where(eq(vehicleDocuments.id, input.documentId)).limit(1)
  if (!doc) return { ok: false, error: 'Document not found' }
  if (doc.linkedEventId) return { ok: false, error: 'This receipt was already saved.' }
  const vehId = doc.inventoryVehicleId
  let eventId: string
  if (input.isReturn && input.originalEventId) {
    // Reuse the B1 return/refund chain (append-only, linked to the original purchase).
    const r = await addReturnRefund({ inventoryVehicleId: vehId, originalEventId: input.originalEventId, econ: 'refund',
      refundMethod: 'card', cash: true, amountCents: input.amountCents, eventDate: input.eventDate, refundStatus: 'settled',
      memo: input.memo ?? `Return (receipt ${input.vendor ?? ''})`, actor: input.actor })
    if (!r.ok) return { ok: false, error: r.error }
    const [ev] = await db.select({ id: vehicleFinancialEvents.id }).from(vehicleFinancialEvents)
      .where(and(eq(vehicleFinancialEvents.inventoryVehicleId, vehId), eq(vehicleFinancialEvents.originalEventId, input.originalEventId)))
      .orderBy(desc(vehicleFinancialEvents.createdAt)).limit(1)
    eventId = ev?.id ?? ''
  } else {
    eventId = await addExpenseEvent({ inventoryVehicleId: vehId, economicCategory: input.economicCategory, amountCents: input.amountCents,
      eventDate: input.eventDate, vendor: input.vendor, memo: input.memo, paymentAccountRef: input.paymentAccountRef ?? 'unknown', actor: input.actor })
  }
  // Link event → document, document → event; stamp document as 'receipt_ai' source on the event.
  if (eventId) await db.update(vehicleFinancialEvents).set({ documentId: input.documentId, source: doc.aiStatus === 'extracted' ? 'receipt_ai' : 'manual' }).where(eq(vehicleFinancialEvents.id, eventId))
  await db.update(vehicleDocuments).set({
    linkedEventId: eventId || null, isReturn: input.isReturn ?? false, originalEventId: input.originalEventId ?? null,
    receiptTotalCents: input.receiptTotalCents ?? null,
    confirmed: { vendor: input.vendor ?? null, date: input.eventDate, category: input.economicCategory, amountCents: input.amountCents, receiptTotalCents: input.receiptTotalCents ?? null, isReturn: input.isReturn ?? false } as any,
    updatedAt: new Date(),
  }).where(eq(vehicleDocuments.id, input.documentId))
  return { ok: true, eventId }
}

// ── Opening-inventory backfill (review-based; import facts, never fabricate history) ──
export interface BackfillRow { year?: string; make?: string; model?: string; color?: string; partialVin?: string; acquisitionCost?: string; acquisitionDate?: string; daysOnLot?: string }
export interface BackfillPreview extends BackfillRow {
  rowIndex: number
  matchedVehicleId: string | null; matchedVin: string | null; vinConfidence: 'full_vin' | 'partial_only' | 'none'
  proposedStock: string | null; parsedCostCents: number | null; parsedDate: string | null
  missing: string[]; completeness: FinancialCompleteness
}

/** Dry-run: match each spreadsheet row to a canonical vehicle by FULL VIN only (high confidence);
 *  a partial VIN is NOT sufficient to auto-assign — it stays needs_review. Fabricates nothing. */
export async function previewBackfill(rows: BackfillRow[]): Promise<BackfillPreview[]> {
  const db = getDb()
  const out: BackfillPreview[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const rawVin = (r.partialVin ?? '').trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '')
    const isFullVin = rawVin.length === 17
    let matchedVehicleId: string | null = null, matchedVin: string | null = null
    if (isFullVin) {
      const [m] = await db.select({ id: vehicles.id, vin: vehicles.vin }).from(vehicles).where(eq(vehicles.vin, rawVin)).limit(1)
      if (m) { matchedVehicleId = m.id; matchedVin = m.vin }
    }
    const parsedCostCents = r.acquisitionCost ? Math.round(parseFloat(r.acquisitionCost.replace(/[^0-9.]/g, '')) * 100) : null
    const parsedDate = r.acquisitionDate && /^\d{4}-\d{2}-\d{2}$/.test(r.acquisitionDate) ? r.acquisitionDate : null
    const proposedStock = isFullVin ? await generateStockNumber(rawVin) : null   // no fabricated stock from partial VIN
    const missing: string[] = []
    if (!isFullVin) missing.push('full VIN')
    if (parsedCostCents == null) missing.push('acquisition cost')
    if (!parsedDate) missing.push('acquisition date (YYYY-MM-DD)')
    const completeness: FinancialCompleteness = !isFullVin ? 'needs_review' : 'historical_incomplete'
    out.push({ ...r, rowIndex: i, matchedVehicleId, matchedVin, vinConfidence: isFullVin ? 'full_vin' : rawVin.length >= 4 ? 'partial_only' : 'none',
      proposedStock, parsedCostCents, parsedDate, missing, completeness })
  }
  return out
}

/** Commit reviewed/confirmed backfill rows. Only creates records for rows with the minimum facts
 *  (cost + date); a full VIN yields a stock# now, otherwise the vehicle is created but left in
 *  needs_review with NO stock until identity is resolved. Never fabricates recon history. */
export async function commitBackfill(confirmed: (BackfillRow & { confirm: boolean })[], actor: string | null): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0
  for (const r of confirmed) {
    const cost = r.acquisitionCost ? Math.round(parseFloat(r.acquisitionCost.replace(/[^0-9.]/g, '')) * 100) : null
    const date = r.acquisitionDate && /^\d{4}-\d{2}-\d{2}$/.test(r.acquisitionDate) ? r.acquisitionDate : null
    const rawVin = (r.partialVin ?? '').trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '')
    if (!r.confirm || cost == null || !date) { skipped++; continue }
    await createAcquisition({
      vin: rawVin.length === 17 ? rawVin : null, year: r.year ?? null, make: r.make ?? null, model: r.model ?? null, color: r.color ?? null,
      acquisitionCostCents: cost, acquiredAt: date, acquisitionSource: 'opening_inventory', origin: 'spreadsheet_backfill',
      completenessOverride: rawVin.length === 17 ? 'historical_incomplete' : 'needs_review', actor,
    })
    created++
  }
  return { created, skipped }
}
