/**
 * Persisted cross-source matches (purchase_links, migration 0079) — the ONLY writes in the reconciliation
 * layer. A person confirms that two records are the same purchase, or dismisses a suggestion. Nothing is ever
 * auto-linked, deleted, or posted anywhere: undoing a decision marks it 'cleared' (kept), and every decision
 * is appended to fin_events. Receipt ↔ bank stays in fin_receipt_matches (apps/finance/receipts-cfo.ts).
 */
import { and, eq, inArray, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { businessReceipts } from '@/apps/expenses/schema'
import { vehicleFinancialEvents } from '@/apps/auto-sales/schema'
import { checks } from '@/apps/checks/schema'
import { liveLedgerIds } from '@/apps/auto-sales/receipt-expenses'
import { finEvents, finObligations, finQbPurchases, finTransactions, purchaseLinks } from './schema'

export const LINK_KINDS = {
  receipt_qb:            { aType: 'receipt',    bType: 'qb_purchase',   label: 'Receipt ↔ QuickBooks entry' },
  receipt_vehicle_event: { aType: 'receipt',    bType: 'vehicle_event', label: 'Receipt ↔ inventory-vehicle cost line' },
  check_txn:             { aType: 'check',      bType: 'bank_txn',      label: 'Written check ↔ bank payment' },
  check_receipt:         { aType: 'check',      bType: 'receipt',       label: 'Written check ↔ receipt' },
  txn_qb:                { aType: 'bank_txn',   bType: 'qb_purchase',   label: 'Bank payment ↔ QuickBooks entry' },
  bill_payment:          { aType: 'obligation', bType: 'bank_txn',      label: 'Expected bill ↔ actual payment' },
} as const
export type LinkKind = keyof typeof LINK_KINDS
export type RecordType = 'receipt' | 'qb_purchase' | 'vehicle_event' | 'check' | 'bank_txn' | 'obligation'
export function isLinkKind(k: unknown): k is LinkKind { return typeof k === 'string' && k in LINK_KINDS }
export type LinkRow = typeof purchaseLinks.$inferSelect
export interface LinkResult { ok: boolean; error?: string; id?: string; already?: boolean; needsResolution?: boolean }

/**
 * WHY a confirmed receipt ↔ vehicle-expense match may be separated. There is no default: separating one
 * without a reason is refused (see vehicleMatchAtRisk).
 *   different_purchases — a person confirmed these are two real purchases; both count.
 *   assignment_change   — the receipt is being taken off the vehicle in the same operation (vehicle-link).
 *   duplicate_removed   — the typed vehicle expense was just reversed as the duplicate; the receipt remains.
 */
export type VehicleSplitReason = 'different_purchases' | 'assignment_change' | 'duplicate_removed'
export const VEHICLE_MATCH_NEEDS_RESOLUTION = 'This receipt is assigned to the same vehicle as the expense it is matched to. Undoing the match would count the purchase twice on that vehicle. Choose how to resolve it: keep them matched, confirm they are two different purchases, or remove the duplicate vehicle expense.'

export interface VehicleMatchRisk { linkId: string | null; receiptId: string; eventId: string; inventoryVehicleId: string; receiptCents: number | null; eventCents: number }
/**
 * Is this confirmed match the only thing keeping ONE purchase from counting TWICE on a vehicle? True when the
 * receipt is assigned to a sales-inventory vehicle and the matched expense is a live line on that same
 * vehicle — the exact case where the vehicle folder shows the ledger line and hides the receipt's own line.
 */
export async function vehicleMatchAtRisk(link: { id?: string | null; kind: string; aId: string; bId: string; status: string }): Promise<VehicleMatchRisk | null> {
  if (link.kind !== 'receipt_vehicle_event' || link.status !== 'confirmed' || !UUID.test(link.aId) || !UUID.test(link.bId)) return null
  const db = getDb()
  const [r] = await db.select({ status: businessReceipts.status, vehicleId: businessReceipts.inventoryVehicleId, totalCents: businessReceipts.totalCents })
    .from(businessReceipts).where(eq(businessReceipts.id, link.aId)).limit(1)
  if (!r || !r.vehicleId || r.status === 'rejected') return null
  const ledger = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.inventoryVehicleId, r.vehicleId))
  const ev = ledger.find((e) => e.id === link.bId)
  if (!ev || !liveLedgerIds(ledger).has(ev.id)) return null
  return { linkId: link.id ?? null, receiptId: link.aId, eventId: ev.id, inventoryVehicleId: r.vehicleId, receiptCents: r.totalCents, eventCents: ev.amountCents }
}
/** The same question by saved-match id (for the reconcile page). */
export async function vehicleMatchRiskById(id: string): Promise<VehicleMatchRisk | null> {
  if (!UUID.test(id)) return null
  const [row] = await getDb().select().from(purchaseLinks).where(eq(purchaseLinks.id, id)).limit(1)
  return row ? vehicleMatchAtRisk(row) : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function uniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown; message?: unknown }; message?: unknown }
  return e?.code === '23505' || e?.cause?.code === '23505' || /duplicate key value|unique constraint/i.test(`${String(e?.message ?? '')} ${String(e?.cause?.message ?? '')}`)
}

/** Does this record exist and is it eligible to be matched? Returns an error string, or null when fine. */
async function checkRecord(type: RecordType, id: string): Promise<string | null> {
  const db = getDb()
  if (type !== 'qb_purchase' && !UUID.test(id)) return 'Record not found.'
  if (type === 'receipt') {
    const [r] = await db.select({ status: businessReceipts.status }).from(businessReceipts).where(eq(businessReceipts.id, id)).limit(1)
    return !r ? 'Receipt not found.' : r.status === 'rejected' ? 'A rejected receipt cannot be matched.' : null
  }
  if (type === 'bank_txn') {
    const [t] = await db.select({ direction: finTransactions.direction, removed: finTransactions.removed, pending: finTransactions.pending })
      .from(finTransactions).where(eq(finTransactions.id, id)).limit(1)
    if (!t || t.removed || t.direction !== 'out') return 'That bank payment is not available to match.'
    return t.pending ? 'That bank payment is still pending — match it once it posts.' : null
  }
  if (type === 'qb_purchase') {
    const [q] = await db.select({ missing: finQbPurchases.missingSince }).from(finQbPurchases).where(eq(finQbPurchases.qbKey, id)).limit(1)
    return !q ? 'That QuickBooks entry has not been read into this app.' : q.missing ? 'That QuickBooks entry no longer exists in QuickBooks.' : null
  }
  if (type === 'check') {
    const [c] = await db.select({ qbStatus: checks.qbStatus }).from(checks).where(eq(checks.id, id)).limit(1)
    return !c ? 'Check not found.' : c.qbStatus === 'voided' ? 'A voided check cannot be matched.' : null
  }
  if (type === 'vehicle_event') {
    const [v] = await db.select({ status: vehicleFinancialEvents.status }).from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.id, id)).limit(1)
    return !v ? 'Vehicle cost line not found.' : v.status === 'void' ? 'A voided vehicle cost line cannot be matched.' : null
  }
  const [o] = await db.select({ id: finObligations.id }).from(finObligations).where(eq(finObligations.id, id)).limit(1)
  return o ? null : 'Expected bill not found.'
}

async function audit(action: string, link: { id: string; kind: string; aId: string; bId: string }, actor: string | null, extra?: unknown) {
  await getDb().insert(finEvents).values({ actor, action, entity: 'purchase_link', entityId: link.id, after: { kind: link.kind, a: link.aId, b: link.bId, ...(extra as object ?? {}) }, source: 'manual' }).catch(() => {})
}

export interface DecideInput {
  kind: LinkKind; aId: string; bId: string
  status: 'confirmed' | 'dismissed'
  actor: string | null
  amountCents?: number | null; evidence?: unknown; note?: string | null
  /** Required to turn a confirmed receipt ↔ vehicle-expense match on ONE vehicle into "not the same". */
  vehicleSplit?: VehicleSplitReason
}
/**
 * Record a person's decision about one pair. Idempotent: repeating the same decision returns the existing
 * row. Changing a decision clears the old row (kept as history) and inserts the new one. A confirmed match is
 * exclusive — a record already confirmed to a different partner of the same kind is refused, never replaced.
 */
export async function decideLink(input: DecideInput): Promise<LinkResult> {
  if (!isLinkKind(input.kind)) return { ok: false, error: 'Unknown match type.' }
  const spec = LINK_KINDS[input.kind]
  const db = getDb()
  const [live] = await db.select().from(purchaseLinks)
    .where(and(eq(purchaseLinks.kind, input.kind), eq(purchaseLinks.aId, input.aId), eq(purchaseLinks.bId, input.bId), ne(purchaseLinks.status, 'cleared'))).limit(1)
  if (live?.status === input.status) return { ok: true, id: live.id, already: true }
  // "Not the same" on a confirmed match that is keeping one purchase from counting twice on a vehicle is the
  // same act as undoing it — refused unless the caller states why (never silently separated).
  if (live && input.status === 'dismissed' && !input.vehicleSplit && (await vehicleMatchAtRisk(live))) {
    return { ok: false, needsResolution: true, error: VEHICLE_MATCH_NEEDS_RESOLUTION }
  }
  if (input.status === 'confirmed') {
    for (const [type, id] of [[spec.aType, input.aId], [spec.bType, input.bId]] as [RecordType, string][]) {
      const err = await checkRecord(type, id)
      if (err) return { ok: false, error: err }
    }
    // Matching hides the receipt's own line on the vehicle. A return recorded against that line would be left
    // pointing at nothing — the same rule the Receipts assignment path enforces.
    if (input.kind === 'receipt_vehicle_event' && UUID.test(input.aId)) {
      const [r] = await db.select({ vehicleId: businessReceipts.inventoryVehicleId }).from(businessReceipts).where(eq(businessReceipts.id, input.aId)).limit(1)
      if (r?.vehicleId) {
        const ledger = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.inventoryVehicleId, r.vehicleId))
        const liveIds = liveLedgerIds(ledger)
        if (ledger.some((e) => e.originalEventId === input.aId && liveIds.has(e.id))) {
          return { ok: false, error: 'A return or refund is recorded against this receipt on the vehicle. Reverse that return on the vehicle before matching the receipt to another expense.' }
        }
      }
    }
  }
  if (live) await db.update(purchaseLinks).set({ status: 'cleared', clearedBy: input.actor, clearedAt: new Date() }).where(and(eq(purchaseLinks.id, live.id), ne(purchaseLinks.status, 'cleared')))
  try {
    const [row] = await db.insert(purchaseLinks).values({
      kind: input.kind, aType: spec.aType, aId: input.aId, bType: spec.bType, bId: input.bId, status: input.status,
      amountCents: input.amountCents ?? null, evidence: (input.evidence ?? null) as object | null, note: input.note?.trim() || null, decidedBy: input.actor,
    }).returning({ id: purchaseLinks.id })
    await audit(input.status === 'confirmed' ? 'confirm' : 'dismiss', { id: row.id, kind: input.kind, aId: input.aId, bId: input.bId }, input.actor, { evidence: input.evidence ?? null, ...(input.vehicleSplit ? { vehicleSplit: input.vehicleSplit } : {}) })
    return { ok: true, id: row.id }
  } catch (err) {
    if (!uniqueViolation(err)) throw err
    // Restore the decision we just cleared, then explain: one side already has a confirmed partner.
    if (live) await db.update(purchaseLinks).set({ status: live.status, clearedBy: null, clearedAt: null }).where(eq(purchaseLinks.id, live.id)).catch(() => {})
    return { ok: false, error: 'One of these is already matched to a different record. Undo that match first.' }
  }
}

/**
 * Undo a decision. The row is kept with status 'cleared' (history), and the pair returns to the suggestions.
 * A confirmed receipt ↔ vehicle-expense match on ONE vehicle is NOT undone without a stated reason
 * (`vehicleSplit`): it is refused with needsResolution so the purchase can never silently start counting twice.
 */
export async function clearLink(id: string, actor: string | null, opts: { vehicleSplit?: VehicleSplitReason } = {}): Promise<LinkResult> {
  if (!UUID.test(id)) return { ok: false, error: 'Match not found.' }
  const db = getDb()
  const [row] = await db.select().from(purchaseLinks).where(eq(purchaseLinks.id, id)).limit(1)
  if (!row) return { ok: false, error: 'Match not found.' }
  if (row.status === 'cleared') return { ok: true, id, already: true }
  if (!opts.vehicleSplit && (await vehicleMatchAtRisk(row))) return { ok: false, needsResolution: true, error: VEHICLE_MATCH_NEEDS_RESOLUTION }
  await db.update(purchaseLinks).set({ status: 'cleared', clearedBy: actor, clearedAt: new Date() }).where(and(eq(purchaseLinks.id, id), ne(purchaseLinks.status, 'cleared')))
  await audit('clear', row, actor, { was: row.status, ...(opts.vehicleSplit ? { vehicleSplit: opts.vehicleSplit } : {}) })
  return { ok: true, id }
}

/** Every live (confirmed or dismissed) decision, optionally for some kinds. Cleared rows are history only. */
export async function liveLinks(kinds?: LinkKind[]): Promise<LinkRow[]> {
  const conds = [ne(purchaseLinks.status, 'cleared')]
  if (kinds?.length) conds.push(inArray(purchaseLinks.kind, kinds))
  return getDb().select().from(purchaseLinks).where(and(...conds))
}
