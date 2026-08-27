/**
 * Auto-Sales B0 — read models + append-only writes over the canonical vehicle.
 * Facts only; no accounting policy. No money movement; no QBO/bank writes.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { vehicles } from '@/apps/workflow/schema'
import { inventoryVehicles, vehicleFinancialEvents } from './schema'
import { autoSalesCutoverDate } from '@/apps/settings/db'
import { normalizeVIN } from '@/apps/vehicle-entry/vin'
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
  verifiedAdditionalCents: number
  unverifiedAdditionalCents: number
  knownInvestmentCents: number          // acquisition + verified additional (NOT called "total cost basis")
  proceedsCents: number                 // sale/deposit (B1)
  completeness: FinancialCompleteness
  historicalIncomplete: boolean
}
export function computeSummary(events: (typeof vehicleFinancialEvents.$inferSelect)[], completeness: FinancialCompleteness): VehicleFinancialSummary {
  // Exclude reversed pairs (append-only correction) from all cost math.
  const reversedTargets = new Set(events.filter((e) => e.reversesEventId).map((e) => e.reversesEventId as string))
  const excluded = (e: typeof events[number]) => e.status === 'void' || Boolean(e.reversesEventId) || reversedTargets.has(e.id)

  let acq = 0, addV = 0, contraV = 0, addU = 0, contraU = 0, proceeds = 0
  for (const e of events) {
    if (excluded(e)) continue
    const rel = costRelevance(e.economicCategory as EconomicCategory)
    const verified = e.status === 'verified' || e.status === 'reconciled'
    if (e.economicCategory === 'acquisition') { acq += e.amountCents; continue }
    if (rel === 'cost_add') { verified ? (addV += e.amountCents) : (addU += e.amountCents) }
    else if (rel === 'cost_contra') { verified ? (contraV += e.amountCents) : (contraU += e.amountCents) }
    else if (rel === 'proceeds' && verified) { proceeds += e.amountCents }
  }
  const verifiedAdditional = addV - contraV
  const unverifiedAdditional = addU - contraU
  return {
    acquisitionCostCents: acq, verifiedAdditionalCents: verifiedAdditional, unverifiedAdditionalCents: unverifiedAdditional,
    knownInvestmentCents: acq + verifiedAdditional, proceedsCents: proceeds,
    completeness, historicalIncomplete: completeness === 'historical_incomplete' || completeness === 'partially_reconstructed' || completeness === 'needs_review',
  }
}

export interface InventoryRow {
  id: string; stockNumber: string | null; vin: string | null; year: string | null; make: string | null; model: string | null; color: string | null
  status: string; acquiredAt: string | null; daysOnLot: number | null; completeness: FinancialCompleteness; summary: VehicleFinancialSummary
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
  return rows.map(({ inv, v }) => ({
    id: inv.id, stockNumber: inv.stockNumber, vin: v.vin, year: v.year, make: v.make, model: v.model, color: v.color,
    status: inv.status, acquiredAt: inv.acquiredAt,
    daysOnLot: inv.acquiredAt ? Math.max(0, Math.round((today.getTime() - new Date(inv.acquiredAt + 'T00:00:00Z').getTime()) / 86400_000)) : null,
    completeness: inv.financialCompleteness as FinancialCompleteness,
    summary: computeSummary(byVeh.get(inv.id) ?? [], inv.financialCompleteness as FinancialCompleteness),
  }))
}

export interface VehicleFolder {
  inv: typeof inventoryVehicles.$inferSelect; vehicle: typeof vehicles.$inferSelect
  events: (typeof vehicleFinancialEvents.$inferSelect)[]; summary: VehicleFinancialSummary; daysOnLot: number | null
}
export async function getVehicleFolder(id: string): Promise<VehicleFolder | null> {
  const db = getDb()
  const [row] = await db.select({ inv: inventoryVehicles, v: vehicles }).from(inventoryVehicles)
    .innerJoin(vehicles, eq(inventoryVehicles.vehicleId, vehicles.id)).where(eq(inventoryVehicles.id, id)).limit(1)
  if (!row) return null
  const events = await db.select().from(vehicleFinancialEvents)
    .where(eq(vehicleFinancialEvents.inventoryVehicleId, id)).orderBy(vehicleFinancialEvents.eventDate, vehicleFinancialEvents.createdAt)
  const daysOnLot = row.inv.acquiredAt ? Math.max(0, Math.round((Date.now() - new Date(row.inv.acquiredAt + 'T00:00:00Z').getTime()) / 86400_000)) : null
  return { inv: row.inv, vehicle: row.v, events, summary: computeSummary(events, row.inv.financialCompleteness as FinancialCompleteness), daysOnLot }
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
