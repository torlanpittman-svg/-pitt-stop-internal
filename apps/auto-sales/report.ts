/**
 * Auto-Sales — Monthly accountant report (PURE builder). Takes already-loaded inventory rows + their
 * ledger events and produces the month report (sections A–D) deterministically. Kept pure + free of DB/
 * timezone side-effects so it is unit-testable and REPRODUCIBLE: the same source data + month always
 * yields the same figures (and the same content hash).
 *
 * Timezone correctness: acquisition/sale/event dates are stored as plain business DATES ('YYYY-MM-DD',
 * already local to the shop) — month membership is a string-prefix comparison, so there is NO UTC month-
 * boundary error. The `tz` is carried for provenance only.
 *
 * Nothing here posts to QuickBooks or asserts an accounting treatment — profit is MANAGEMENT/ESTIMATED
 * and taxes/fees are separately stated. Missing data is FLAGGED, never silently treated as zero.
 */
import { computeCostBasis, computeSaleFinancials, type CalcEvent, type VehicleCostBasis } from './calc'

export interface ReportInvRow {
  id: string; stockNumber: string | null; vin: string | null; year: string | null; make: string | null; model: string | null
  status: string; acquiredAt: string | null; soldAt: string | null; saleFinalized: boolean
  salePriceCents: number | null; saleTaxCents: number | null; saleDocFeesCents: number | null
  saleOtherChargesCents: number | null; saleDiscountCents: number | null; amountReceivedCents: number | null
  salePaymentMethod: string | null; buyerRef: string | null; salesperson: string | null
  financialCompleteness: string
}
export interface ReportEvent extends CalcEvent { eventDate: string; evidence?: unknown }

// ── date helpers (UTC-noon calendar math on 'YYYY-MM-DD' → DST-safe, no tz drift) ──
export function monthStart(month: string): string { return `${month}-01` }
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) // day 0 of next month = last day
}
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10)
}
function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400_000))
}
const inMonth = (date: string | null, month: string) => !!date && date.slice(0, 7) === month
const onOrBefore = (date: string | null, bound: string) => !!date && date <= bound
const afterOrNull = (date: string | null, bound: string) => date == null || date > bound

const SOLD_STATES = ['sold', 'delivered', 'wholesaled']
const isSold = (r: ReportInvRow) => r.saleFinalized || SOLD_STATES.includes(r.status)

/** Cost basis as of a date: only events on/before the date count (point-in-time, reproducible). */
function basisAsOf(events: ReportEvent[], asOf: string): VehicleCostBasis {
  return computeCostBasis(events.filter((e) => e.eventDate <= asOf))
}

// ── Section shapes ──
export interface AcquiredRow {
  id: string; stockNumber: string | null; ymm: string; vin: string | null; acquisitionDate: string | null
  acquisitionPriceCents: number; acquisitionRelatedCents: number; reconToDateCents: number; reconThisMonthCents: number
  status: string; flags: string[]
}
export interface SoldRow {
  id: string; stockNumber: string | null; ymm: string; vin: string | null; acquisitionDate: string | null; saleDate: string | null
  buyer: string | null; acquisitionPriceCents: number; acquisitionRelatedCents: number; reconditioningCents: number; totalInvestedCents: number
  salePriceCents: number; taxCents: number; feesCents: number; discountCents: number; totalTransactionCents: number
  amountReceivedCents: number; balanceRemainingCents: number; estGrossProfitCents: number; paymentMethod: string | null
  salesperson: string | null; flags: string[]
}
export interface EndingInvRow {
  id: string; stockNumber: string | null; ymm: string; vin: string | null; acquisitionDate: string | null; daysInInventory: number | null
  acquisitionPriceCents: number; acquisitionRelatedCents: number; reconditioningCents: number; totalInvestedCents: number
  status: string; flags: string[]
}
export interface MonthSummary {
  beginningInventoryCount: number; beginningInventoryValueCents: number
  acquiredCount: number; acquiredPriceTotalCents: number; acquisitionRelatedAddedCents: number; reconAddedCents: number
  soldCount: number; salesPriceTotalCents: number; taxCollectedCents: number; feesCollectedCents: number; discountsCents: number
  totalTransactionCents: number; amountReceivedCents: number; receivablesRemainingCents: number
  costBasisOfSoldCents: number; estGrossProfitOnSoldCents: number
  endingInventoryCount: number; endingInventoryValueCents: number
  missingAcquisitionPriceCount: number; missingAcquisitionPriceValueCents: number
  soldIncompleteCount: number; reversedSalesCount: number
}
export interface MonthlyReport {
  month: string; tz: string; monthStart: string; monthEnd: string; generatedAt: string
  summary: MonthSummary; acquired: AcquiredRow[]; sold: SoldRow[]; endingInventory: EndingInvRow[]
  flags: string[]; contentHash: string
}

const ymmOf = (r: ReportInvRow) => [r.year, r.make, r.model].filter(Boolean).join(' ') || 'Unidentified vehicle'

/** Deterministic FNV-1a hash of the canonical totals → drift detection + reproducibility check. */
export function hashTotals(summary: MonthSummary): string {
  const keys = Object.keys(summary).sort() as (keyof MonthSummary)[]
  const canonical = keys.map((k) => `${k}=${summary[k]}`).join(';')
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) { h ^= canonical.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Build the monthly report from source rows + events. `generatedAt` is injected (caller supplies) so the
 *  pure builder stays deterministic; it does NOT affect the financial figures or the content hash. */
export function buildMonthlyReport(
  rows: ReportInvRow[], eventsByVehicle: Map<string, ReportEvent[]>, month: string, tz: string, generatedAt: string,
): MonthlyReport {
  const mStart = monthStart(month), mEnd = monthEnd(month), dayBeforeStart = addDays(mStart, -1)
  const ev = (id: string) => eventsByVehicle.get(id) ?? []

  const acquired: AcquiredRow[] = []
  const sold: SoldRow[] = []
  const endingInventory: EndingInvRow[] = []
  const summary: MonthSummary = {
    beginningInventoryCount: 0, beginningInventoryValueCents: 0,
    acquiredCount: 0, acquiredPriceTotalCents: 0, acquisitionRelatedAddedCents: 0, reconAddedCents: 0,
    soldCount: 0, salesPriceTotalCents: 0, taxCollectedCents: 0, feesCollectedCents: 0, discountsCents: 0,
    totalTransactionCents: 0, amountReceivedCents: 0, receivablesRemainingCents: 0,
    costBasisOfSoldCents: 0, estGrossProfitOnSoldCents: 0,
    endingInventoryCount: 0, endingInventoryValueCents: 0,
    missingAcquisitionPriceCount: 0, missingAcquisitionPriceValueCents: 0,
    soldIncompleteCount: 0, reversedSalesCount: 0,
  }

  for (const r of rows) {
    const events = ev(r.id)
    const soldInMonth = isSold(r) && inMonth(r.soldAt, month)

    // Reversed/corrected sales dated in this month (reversal adjustment events tagged in evidence).
    for (const e of events) {
      const tag = (e.evidence as { saleReversal?: boolean } | null | undefined)?.saleReversal
      if (tag && inMonth(e.eventDate, month)) { summary.reversedSalesCount++; break }
    }

    // Beginning inventory: held at the START of the month (acquired before month, not sold before month).
    if (onOrBefore(r.acquiredAt, dayBeforeStart) && afterOrNull(r.soldAt, dayBeforeStart)) {
      const b = basisAsOf(events, dayBeforeStart)
      summary.beginningInventoryCount++; summary.beginningInventoryValueCents += b.totalInvestedCents
    }

    // Ending inventory: held at the END of the month (acquired on/before month-end, not sold by month-end).
    if (onOrBefore(r.acquiredAt, mEnd) && afterOrNull(r.soldAt, mEnd)) {
      const b = basisAsOf(events, mEnd)
      const flags: string[] = []
      if (b.acquisitionPriceCents === 0) flags.push('missing acquisition price')
      if (r.financialCompleteness !== 'complete') flags.push('costs may be incomplete')
      summary.endingInventoryCount++; summary.endingInventoryValueCents += b.totalInvestedCents
      if (b.acquisitionPriceCents === 0) { summary.missingAcquisitionPriceCount++; summary.missingAcquisitionPriceValueCents += b.totalInvestedCents }
      endingInventory.push({
        id: r.id, stockNumber: r.stockNumber, ymm: ymmOf(r), vin: r.vin, acquisitionDate: r.acquiredAt,
        daysInInventory: r.acquiredAt ? daysBetween(r.acquiredAt, mEnd) : null,
        acquisitionPriceCents: b.acquisitionPriceCents, acquisitionRelatedCents: b.acquisitionRelatedCents,
        reconditioningCents: b.reconditioningCents, totalInvestedCents: b.totalInvestedCents, status: r.status, flags,
      })
    }

    // Acquired during the month.
    if (inMonth(r.acquiredAt, month)) {
      const bNow = computeCostBasis(events)
      const bAtAcq = basisAsOf(events, r.acquiredAt!)
      const reconThisMonth = computeCostBasis(events.filter((e) => inMonth(e.eventDate, month))).reconditioningCents
      const flags: string[] = []
      if (bAtAcq.acquisitionPriceCents === 0) flags.push('missing acquisition price')
      summary.acquiredCount++; summary.acquiredPriceTotalCents += bAtAcq.acquisitionPriceCents
      acquired.push({
        id: r.id, stockNumber: r.stockNumber, ymm: ymmOf(r), vin: r.vin, acquisitionDate: r.acquiredAt,
        acquisitionPriceCents: bAtAcq.acquisitionPriceCents, acquisitionRelatedCents: bNow.acquisitionRelatedCents,
        reconToDateCents: bNow.reconditioningCents, reconThisMonthCents: reconThisMonth, status: r.status, flags,
      })
    }

    // Costs added during the month (any vehicle) — acquisition-related + reconditioning.
    const monthEvents = events.filter((e) => inMonth(e.eventDate, month))
    if (monthEvents.length) {
      const monthBasis = computeCostBasis(monthEvents)
      summary.acquisitionRelatedAddedCents += monthBasis.acquisitionRelatedCents
      summary.reconAddedCents += monthBasis.reconditioningCents
    }

    // Sold during the month — full customer-transaction + cost + gross-profit breakdown.
    if (soldInMonth) {
      const b = basisAsOf(events, r.soldAt ?? mEnd)
      const fin = computeSaleFinancials({
        salePriceCents: r.salePriceCents ?? 0, taxCents: r.saleTaxCents ?? 0, docFeesCents: r.saleDocFeesCents ?? 0,
        otherChargesCents: r.saleOtherChargesCents ?? 0, discountCents: r.saleDiscountCents ?? 0, amountReceivedCents: r.amountReceivedCents ?? 0,
      })
      const feesCents = fin.docFeesCents + fin.otherChargesCents
      const saleNet = fin.salePriceCents - fin.discountCents
      const est = saleNet - b.totalInvestedCents
      const flags: string[] = []
      if ((r.salePriceCents ?? 0) === 0) flags.push('missing sale price')
      if (b.acquisitionPriceCents === 0) flags.push('missing acquisition price')
      if (fin.balanceRemainingCents > 0) flags.push('balance outstanding')
      if (r.financialCompleteness !== 'complete') flags.push('costs may be incomplete')
      if (flags.length) summary.soldIncompleteCount++

      summary.soldCount++
      summary.salesPriceTotalCents += fin.salePriceCents
      summary.taxCollectedCents += fin.taxCents
      summary.feesCollectedCents += feesCents
      summary.discountsCents += fin.discountCents
      summary.totalTransactionCents += fin.totalTransactionCents
      summary.amountReceivedCents += fin.amountReceivedCents
      summary.receivablesRemainingCents += fin.balanceRemainingCents
      summary.costBasisOfSoldCents += b.totalInvestedCents
      summary.estGrossProfitOnSoldCents += est

      sold.push({
        id: r.id, stockNumber: r.stockNumber, ymm: ymmOf(r), vin: r.vin, acquisitionDate: r.acquiredAt, saleDate: r.soldAt,
        buyer: r.buyerRef, acquisitionPriceCents: b.acquisitionPriceCents, acquisitionRelatedCents: b.acquisitionRelatedCents,
        reconditioningCents: b.reconditioningCents, totalInvestedCents: b.totalInvestedCents,
        salePriceCents: fin.salePriceCents, taxCents: fin.taxCents, feesCents, discountCents: fin.discountCents,
        totalTransactionCents: fin.totalTransactionCents, amountReceivedCents: fin.amountReceivedCents,
        balanceRemainingCents: fin.balanceRemainingCents, estGrossProfitCents: est, paymentMethod: r.salePaymentMethod,
        salesperson: r.salesperson, flags,
      })
    }
  }

  // Stable ordering (reproducible output regardless of DB row order).
  const byStock = (a: { stockNumber: string | null; id: string }, b: { stockNumber: string | null; id: string }) =>
    (a.stockNumber ?? a.id).localeCompare(b.stockNumber ?? b.id)
  acquired.sort(byStock); sold.sort(byStock); endingInventory.sort(byStock)

  const flags: string[] = []
  if (summary.missingAcquisitionPriceCount > 0) flags.push(`${summary.missingAcquisitionPriceCount} vehicle(s) in ending inventory have no acquisition price recorded`)
  if (summary.soldIncompleteCount > 0) flags.push(`${summary.soldIncompleteCount} sold vehicle(s) have incomplete financial information`)
  if (summary.receivablesRemainingCents > 0) flags.push(`$${(summary.receivablesRemainingCents / 100).toLocaleString()} of receivables outstanding on sales this month`)
  if (summary.reversedSalesCount > 0) flags.push(`${summary.reversedSalesCount} sale(s) reversed/corrected during the month`)

  return {
    month, tz, monthStart: mStart, monthEnd: mEnd, generatedAt,
    summary, acquired, sold, endingInventory, flags, contentHash: hashTotals(summary),
  }
}
