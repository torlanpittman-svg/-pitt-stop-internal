/**
 * Auto-Sales — Monthly report data loader + finalize/snapshot layer.
 *
 * The LIVE report is always recomputed from source (inventory + ledger) via the pure builder. FINALIZE
 * captures the exact computed values so a later data correction cannot silently rewrite what a finalized
 * month claimed; the prior finalization is kept (marked superseded), never deleted. `reportStatus`
 * compares the live content hash to the latest finalized snapshot → live | finalized | changed.
 *
 * No QuickBooks writes; no money movement. Read-only over operational data + append-only snapshots.
 */
import { desc, eq, and, inArray } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { vehicles } from '@/apps/workflow/schema'
import { inventoryVehicles, vehicleFinancialEvents, autoSalesReportSnapshots } from './schema'
import { buildMonthlyReport, type MonthlyReport, type ReportInvRow, type ReportEvent } from './report'

/** Reporting timezone (business timezone). Matches the shop convention (SHOP_TIMEZONE, default Central).
 *  Month membership uses plain business DATES, so this is provenance only — no UTC boundary risk. */
export function reportingTimezone(): string { return process.env.SHOP_TIMEZONE || 'America/Chicago' }

/** Valid 'YYYY-MM'. */
export function isValidMonth(month: string): boolean { return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) }

/** The current calendar month in the reporting timezone ('YYYY-MM'). */
export function currentReportMonth(tz = reportingTimezone()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date())
  return parts.slice(0, 7)
}

/** Load + compute the LIVE monthly report from source data. */
export async function loadMonthlyReport(month: string, tz = reportingTimezone(), generatedAt = new Date().toISOString()): Promise<MonthlyReport> {
  const db = getDb()
  const rows = await db.select({ inv: inventoryVehicles, v: vehicles }).from(inventoryVehicles)
    .innerJoin(vehicles, eq(inventoryVehicles.vehicleId, vehicles.id))
  const invRows: ReportInvRow[] = rows.map(({ inv, v }) => ({
    id: inv.id, stockNumber: inv.stockNumber, vin: v.vin, year: v.year, make: v.make, model: v.model,
    status: inv.status, acquiredAt: inv.acquiredAt, soldAt: inv.soldAt, saleFinalized: !!inv.saleFinalizedAt,
    salePriceCents: inv.salePriceCents, saleTaxCents: inv.saleTaxCents, saleDocFeesCents: inv.saleDocFeesCents,
    saleOtherChargesCents: inv.saleOtherChargesCents, saleDiscountCents: inv.saleDiscountCents, amountReceivedCents: inv.amountReceivedCents,
    salePaymentMethod: inv.salePaymentMethod, buyerRef: inv.buyerRef, salesperson: inv.salesperson,
    financialCompleteness: inv.financialCompleteness,
  }))
  const eventsByVehicle = new Map<string, ReportEvent[]>()
  if (invRows.length) {
    const events = await db.select().from(vehicleFinancialEvents).where(inArray(vehicleFinancialEvents.inventoryVehicleId, invRows.map((r) => r.id)))
    for (const e of events) {
      const a = eventsByVehicle.get(e.inventoryVehicleId) ?? []
      a.push({ id: e.id, economicCategory: e.economicCategory, amountCents: e.amountCents, status: e.status, reversesEventId: e.reversesEventId, eventDate: e.eventDate, evidence: e.evidence })
      eventsByVehicle.set(e.inventoryVehicleId, a)
    }
  }
  return buildMonthlyReport(invRows, eventsByVehicle, month, tz, generatedAt)
}

export type ReportState = 'live' | 'finalized' | 'changed'
export interface ReportStatusResult {
  state: ReportState
  latest: (typeof autoSalesReportSnapshots.$inferSelect) | null
  finalizedCount: number
}
/** Compare the live report to the latest finalized snapshot for its month. */
export async function reportStatus(report: MonthlyReport): Promise<ReportStatusResult> {
  const db = getDb()
  const finals = await db.select().from(autoSalesReportSnapshots)
    .where(and(eq(autoSalesReportSnapshots.reportMonth, report.month), eq(autoSalesReportSnapshots.status, 'final')))
    .orderBy(desc(autoSalesReportSnapshots.createdAt))
  const latest = finals[0] ?? null
  if (!latest) return { state: 'live', latest: null, finalizedCount: 0 }
  return { state: latest.contentHash === report.contentHash ? 'finalized' : 'changed', latest, finalizedCount: finals.length }
}

/** All snapshots for a month (final + superseded), newest first. */
export async function listSnapshots(month: string): Promise<(typeof autoSalesReportSnapshots.$inferSelect)[]> {
  return getDb().select().from(autoSalesReportSnapshots)
    .where(eq(autoSalesReportSnapshots.reportMonth, month)).orderBy(desc(autoSalesReportSnapshots.createdAt))
}

/**
 * Finalize a month: recompute the live report and persist it as a `final` snapshot. Any existing final
 * for the month is marked `superseded` (kept for the change history) — never deleted. Returns the new
 * snapshot id + whether it superseded a prior one. Authorization is enforced at the action layer.
 */
export async function finalizeMonthlyReport(month: string, generatedBy: string | null, note?: string, tz = reportingTimezone()): Promise<{ ok: boolean; id?: string; superseded: boolean; error?: string }> {
  if (!isValidMonth(month)) return { ok: false, superseded: false, error: 'Invalid month.' }
  const db = getDb()
  const report = await loadMonthlyReport(month, tz)
  const prior = await db.update(autoSalesReportSnapshots).set({ status: 'superseded', supersededAt: new Date() })
    .where(and(eq(autoSalesReportSnapshots.reportMonth, month), eq(autoSalesReportSnapshots.status, 'final')))
    .returning({ id: autoSalesReportSnapshots.id })
  const [row] = await db.insert(autoSalesReportSnapshots).values({
    reportMonth: month, tz, status: 'final', contentHash: report.contentHash,
    totals: report.summary as unknown as object, payload: report as unknown as object, note: note ?? null, generatedBy,
  }).returning({ id: autoSalesReportSnapshots.id })
  return { ok: true, id: row.id, superseded: prior.length > 0 }
}
