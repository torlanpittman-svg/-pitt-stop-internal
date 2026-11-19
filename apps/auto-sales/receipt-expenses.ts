/**
 * Auto-Sales — receipts assigned to an inventory vehicle on the Receipts page, shown as that vehicle's cost lines.
 *
 * ONE PURCHASE = ONE RECORD. A receipt assigned to a vehicle (business_receipts.inventory_vehicle_id) is NOT
 * copied into vehicle_financial_events. It is read here and handed to the existing money math (computeSummary,
 * calc.ts, the monthly report) in the SAME row shape as a ledger event, so the vehicle folder shows every
 * expense together and nothing can be counted twice:
 *
 *   - assigned, on its own      → one cost line, id = the receipt id, source 'business_receipt'.
 *       filed / approved        → verified (counts in "In it so far")
 *       still needs attention   → unverified (listed as pending, not counted yet)
 *       rejected                → not shown
 *   - assigned AND matched to an expense already typed on the vehicle (a confirmed purchase_links row of
 *     kind receipt_vehicle_event) → NO extra line. The existing ledger line keeps counting, exactly as it was
 *     entered, and simply carries the receipt as its document. If that ledger line is later removed/voided,
 *     the receipt counts on its own again.
 *
 * Returns/refunds stay in the ledger (real rows) and point at the purchase through original_event_id — for a
 * receipt-backed line that id is the receipt id, so the existing "returned / remaining" math works unchanged.
 * Read-only. No QuickBooks call, no money movement.
 */
import { and, eq, inArray, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { businessReceipts } from '@/apps/expenses/schema'
import { purchaseLinks } from '@/apps/finance/schema'
import type { vehicleFinancialEvents } from './schema'
import type { EconomicCategory } from './types'

export type LedgerEvent = typeof vehicleFinancialEvents.$inferSelect
export type ReceiptRow = typeof businessReceipts.$inferSelect

/** `source` value carried by a receipt-backed cost line (never stored in vehicle_financial_events). */
export const RECEIPT_EVENT_SOURCE = 'business_receipt'
export const isReceiptEvent = (e: { source?: string | null }): boolean => e.source === RECEIPT_EVENT_SOURCE

/** Receipts-page category → the vehicle cost bucket. Everything still counts as money in the vehicle. */
export function econForReceiptCategory(category: string | null | undefined): EconomicCategory {
  switch (category) {
    case 'parts': return 'part'
    case 'subcontractor': return 'mechanic'
    case 'shop_supplies': return 'recon_labor'
    default: return 'other'
  }
}

const isComplete = (status: string) => status === 'filed' || status === 'approved'
const dateOf = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)

/** A receipt assigned to a vehicle, in the ledger-event shape the existing calculations consume. Pure. */
export function receiptToEvent(r: ReceiptRow): LedgerEvent {
  return {
    id: r.id,
    inventoryVehicleId: r.inventoryVehicleId as string,
    economicCategory: econForReceiptCategory(r.category),
    cashflowCategory: 'cash_outflow',
    accountingTreatment: 'unknown_confirm',
    amountCents: r.totalCents ?? 0,
    eventDate: r.receiptDate ?? dateOf(r.createdAt),
    vendor: r.vendor,
    memo: r.description ?? r.memo ?? null,
    paymentAccountRef: r.accountRef ?? 'unknown',
    finTransactionId: null,
    originalEventId: null, reversesEventId: null, relatedEventId: null,
    refundStatus: null, refundMethod: null, refundDestinationAccount: null, settledAt: null,
    // A receipt with no total yet is never "verified" money — it is listed as pending at $0.
    status: isComplete(r.status) && r.totalCents != null ? 'verified' : 'unverified',
    confidence: 'manual',
    source: RECEIPT_EVENT_SOURCE,
    documentId: null,
    evidence: { businessReceiptId: r.id, paymentCardLast4: r.paymentLast4 ?? undefined },
    createdBy: r.filedBy ?? r.uploadedBy,
    createdAt: r.createdAt,
  }
}

/** Ledger lines that are live: not void, not a correction, and not corrected away. Pure. */
export function liveLedgerIds(ledger: readonly LedgerEvent[]): Set<string> {
  const reversed = new Set(ledger.filter((e) => e.reversesEventId && e.status !== 'void').map((e) => e.reversesEventId as string))
  return new Set(ledger.filter((e) => e.status !== 'void' && !e.reversesEventId && !reversed.has(e.id)).map((e) => e.id))
}

export interface MergedExpenses {
  events: LedgerEvent[]
  /** receipt-backed line id (= receipt id) → the receipt */
  receiptLines: Map<string, ReceiptRow>
  /** ledger event id → the receipt matched to it (counted once, as the ledger line) */
  matchedReceipts: Map<string, ReceiptRow>
}

/**
 * Combine a set of vehicles' ledger events with the receipts assigned to them. `links` maps receipt id → the
 * ledger event a person confirmed it is the same purchase as. Pure (exported for tests).
 */
export function mergeReceiptExpenses(ledger: readonly LedgerEvent[], receipts: readonly ReceiptRow[], links: ReadonlyMap<string, string>): MergedExpenses {
  const live = liveLedgerIds(ledger)
  const byId = new Map(ledger.map((e) => [e.id, e]))
  const receiptLines = new Map<string, ReceiptRow>()
  const matchedReceipts = new Map<string, ReceiptRow>()
  const added: LedgerEvent[] = []
  for (const r of receipts) {
    if (!r.inventoryVehicleId || r.status === 'rejected') continue
    const matched = links.get(r.id)
    const target = matched ? byId.get(matched) : undefined
    if (target && live.has(target.id) && target.inventoryVehicleId === r.inventoryVehicleId) { matchedReceipts.set(target.id, r); continue }
    receiptLines.set(r.id, r)
    added.push(receiptToEvent(r))
  }
  const events = [...ledger, ...added].sort((a, b) => (a.eventDate === b.eventDate
    ? new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    : a.eventDate < b.eventDate ? -1 : 1))
  return { events, receiptLines, matchedReceipts }
}

/**
 * The Receipts-page receipt a person matched to this ledger line as the SAME purchase (and which is still
 * assigned to a vehicle), or null. While that match stands the ledger line is the only thing counting for the
 * purchase, so it must not be removed/undone on its own: the receipt would start counting in its place.
 */
export async function receiptMatchedToEvent(eventId: string): Promise<{ receiptId: string; vendor: string | null; totalCents: number | null } | null> {
  const db = getDb()
  const [l] = await db.select({ aId: purchaseLinks.aId }).from(purchaseLinks)
    .where(and(eq(purchaseLinks.kind, 'receipt_vehicle_event'), eq(purchaseLinks.status, 'confirmed'), eq(purchaseLinks.bId, eventId))).limit(1)
  if (!l) return null
  const [r] = await db.select({ id: businessReceipts.id, vendor: businessReceipts.vendor, totalCents: businessReceipts.totalCents, vehicleId: businessReceipts.inventoryVehicleId, status: businessReceipts.status })
    .from(businessReceipts).where(eq(businessReceipts.id, l.aId)).limit(1)
  if (!r || !r.vehicleId || r.status === 'rejected') return null
  return { receiptId: r.id, vendor: r.vendor, totalCents: r.totalCents }
}

/** Receipts assigned to these vehicles + their confirmed "same purchase as ledger line" matches. */
export async function loadAssignedReceipts(inventoryVehicleIds: string[]): Promise<{ receipts: ReceiptRow[]; links: Map<string, string> }> {
  const links = new Map<string, string>()
  if (inventoryVehicleIds.length === 0) return { receipts: [], links }
  const db = getDb()
  const receipts = await db.select().from(businessReceipts)
    .where(and(inArray(businessReceipts.inventoryVehicleId, inventoryVehicleIds), ne(businessReceipts.status, 'rejected')))
  if (receipts.length === 0) return { receipts, links }
  const rows = await db.select({ aId: purchaseLinks.aId, bId: purchaseLinks.bId }).from(purchaseLinks)
    .where(and(eq(purchaseLinks.kind, 'receipt_vehicle_event'), eq(purchaseLinks.status, 'confirmed'), inArray(purchaseLinks.aId, receipts.map((r) => r.id))))
  for (const l of rows) links.set(l.aId, l.bId)
  return { receipts, links }
}

/** Ledger events for these vehicles with their assigned receipts merged in — the ONE loader the folder, the
 *  inventory list, the returns math and the monthly report share. */
export async function withAssignedReceipts(inventoryVehicleIds: string[], ledger: readonly LedgerEvent[]): Promise<MergedExpenses> {
  const { receipts, links } = await loadAssignedReceipts(inventoryVehicleIds)
  return mergeReceiptExpenses(ledger, receipts, links)
}
