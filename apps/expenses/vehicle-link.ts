/**
 * Receipt → Auto Sales inventory vehicle. The ONE write path for assigning, changing and removing the vehicle
 * a purchase belongs to (capture, the manager review card and the vehicle folder all end up here).
 *
 * SOURCE OF TRUTH: the receipt row is the expense. Assigning a vehicle sets business_receipts.inventory_vehicle_id
 * — nothing is copied into the vehicle ledger, so a purchase can never be counted twice (see
 * apps/auto-sales/receipt-expenses.ts for how the vehicle folder reads it).
 *
 * "Already on this vehicle": when the same purchase was typed on the vehicle earlier, the receipt is MATCHED to
 * that existing ledger line (a confirmed purchase_links row, kind receipt_vehicle_event — the same record the
 * owner reconcile page uses). The ledger line stays exactly as entered and keeps counting; the receipt becomes
 * its document and adds no second line.
 *
 * Guards (all fail-closed):
 *   - a receipt attached to a customer job cannot also be assigned to a vehicle (and vice-versa);
 *   - a receipt that has a return/refund recorded against it on a vehicle cannot be moved, matched or removed
 *     until that return is reversed — a return must never be left pointing at nothing;
 *   - idempotent: repeating the same assignment is a no-op.
 * Every change is appended to the receipt's audit trail. No QuickBooks call, no money movement.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { vehicles } from '@/apps/workflow/schema'
import { inventoryVehicles, vehicleFinancialEvents } from '@/apps/auto-sales/schema'
import { isRemovableVehicleExpense, labelFor } from '@/apps/auto-sales/types'
import { liveLedgerIds } from '@/apps/auto-sales/receipt-expenses'
import { purchaseLinks } from '@/apps/finance/schema'
import { decideLink, clearLink } from '@/apps/finance/purchase-links'
import { businessReceipts, expenseAllocations } from './schema'
import { appendReceiptAudit, getReceipt } from './db'
import { auditEntry } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)
const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`)
const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

export interface Actor { name: string | null; key?: string | null }

async function vehicleLabel(inventoryVehicleId: string): Promise<string | null> {
  const [v] = await getDb().select({ stock: inventoryVehicles.stockNumber, year: vehicles.year, make: vehicles.make, model: vehicles.model })
    .from(inventoryVehicles).innerJoin(vehicles, eq(inventoryVehicles.vehicleId, vehicles.id)).where(eq(inventoryVehicles.id, inventoryVehicleId)).limit(1)
  if (!v) return null
  return [v.stock, [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle'].filter(Boolean).join(' — ')
}

/** The confirmed "same purchase as this ledger line" match for a receipt, if any. */
async function confirmedMatch(receiptId: string): Promise<{ id: string; eventId: string } | null> {
  const [l] = await getDb().select({ id: purchaseLinks.id, eventId: purchaseLinks.bId }).from(purchaseLinks)
    .where(and(eq(purchaseLinks.kind, 'receipt_vehicle_event'), eq(purchaseLinks.aId, receiptId), eq(purchaseLinks.status, 'confirmed'))).limit(1)
  return l ?? null
}

/** Live returns/refunds recorded on a vehicle against this receipt's cost line (original_event_id = receipt id). */
async function liveReturnsAgainst(receiptId: string): Promise<number> {
  const db = getDb()
  const rows = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.originalEventId, receiptId))
  if (rows.length === 0) return 0
  const vehicleIds = [...new Set(rows.map((r) => r.inventoryVehicleId))]
  const ledger = await db.select().from(vehicleFinancialEvents).where(inArray(vehicleFinancialEvents.inventoryVehicleId, vehicleIds))
  const live = liveLedgerIds(ledger)
  return rows.filter((r) => live.has(r.id)).length
}

// ── "Is this already on the vehicle?" ────────────────────────────────────────────────────────────────
export interface VehicleExpenseCandidate {
  eventId: string; label: string; date: string; vendor: string | null; amountCents: number
  likely: boolean   // same amount, within 3 days (or no receipt date) — very probably this same purchase
}
/**
 * Expenses already entered on a vehicle that a receipt could be the paperwork for: live cost lines that no
 * other receipt is matched to. Same-amount lines close in date come first and are flagged `likely`.
 */
export async function vehicleExpenseCandidates(inventoryVehicleId: string, facts: { amountCents?: number | null; date?: string | null; receiptId?: string | null }): Promise<VehicleExpenseCandidate[]> {
  if (!isUuid(inventoryVehicleId)) return []
  const db = getDb()
  const ledger = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.inventoryVehicleId, inventoryVehicleId))
  const live = liveLedgerIds(ledger)
  const lines = ledger.filter((e) => live.has(e.id) && isRemovableVehicleExpense(e.economicCategory))
  if (lines.length === 0) return []
  const taken = await db.select({ aId: purchaseLinks.aId, bId: purchaseLinks.bId }).from(purchaseLinks)
    .where(and(eq(purchaseLinks.kind, 'receipt_vehicle_event'), eq(purchaseLinks.status, 'confirmed'), inArray(purchaseLinks.bId, lines.map((e) => e.id))))
  const takenByOther = new Set(taken.filter((t) => t.aId !== facts.receiptId).map((t) => t.bId))
  const date = facts.date && /^\d{4}-\d{2}-\d{2}$/.test(facts.date) ? facts.date : null
  return lines.filter((e) => !takenByOther.has(e.id)).map((e) => ({
    eventId: e.id, date: e.eventDate, vendor: e.vendor, amountCents: e.amountCents,
    label: `${labelFor(e.economicCategory)}${e.vendor ? ` · ${e.vendor}` : ''} · ${money(e.amountCents)} · ${e.eventDate}`,
    likely: facts.amountCents != null && e.amountCents === facts.amountCents && (!date || dayGap(date, e.eventDate) <= 3),
  })).sort((a, b) => Number(b.likely) - Number(a.likely) || (a.date < b.date ? 1 : -1))
}

// ── Current assignment (for the review card) ─────────────────────────────────────────────────────────
export interface ReceiptVehicleView {
  inventoryVehicleId: string; vehicleLabel: string
  matchedEventId: string | null; matchedLabel: string | null   // set when counted as an existing vehicle expense
  hasReturns: boolean
}
export async function receiptVehicleViews(receiptIds: string[]): Promise<Map<string, ReceiptVehicleView>> {
  const out = new Map<string, ReceiptVehicleView>()
  if (receiptIds.length === 0) return out
  const db = getDb()
  const rows = await db.select({ id: businessReceipts.id, vehicleId: businessReceipts.inventoryVehicleId }).from(businessReceipts)
    .where(inArray(businessReceipts.id, receiptIds))
  const tagged = rows.filter((r) => r.vehicleId)
  if (tagged.length === 0) return out
  const links = await db.select({ aId: purchaseLinks.aId, bId: purchaseLinks.bId }).from(purchaseLinks)
    .where(and(eq(purchaseLinks.kind, 'receipt_vehicle_event'), eq(purchaseLinks.status, 'confirmed'), inArray(purchaseLinks.aId, tagged.map((r) => r.id))))
  const ledger = await db.select().from(vehicleFinancialEvents).where(inArray(vehicleFinancialEvents.inventoryVehicleId, [...new Set(tagged.map((r) => r.vehicleId as string))]))
  const live = liveLedgerIds(ledger)
  const byId = new Map(ledger.map((e) => [e.id, e]))
  for (const r of tagged) {
    const link = links.find((l) => l.aId === r.id)
    const ev = link ? byId.get(link.bId) : undefined
    const matched = ev && live.has(ev.id) && ev.inventoryVehicleId === r.vehicleId ? ev : null
    out.set(r.id, {
      inventoryVehicleId: r.vehicleId as string, vehicleLabel: (await vehicleLabel(r.vehicleId as string)) ?? 'Vehicle',
      matchedEventId: matched?.id ?? null,
      matchedLabel: matched ? `${labelFor(matched.economicCategory)}${matched.vendor ? ` · ${matched.vendor}` : ''} · ${money(matched.amountCents)} · ${matched.eventDate}` : null,
      hasReturns: ledger.some((e) => e.originalEventId === r.id && live.has(e.id)),
    })
  }
  return out
}

// ── The write ────────────────────────────────────────────────────────────────────────────────────────
export interface SetVehicleInput {
  receiptId: string
  inventoryVehicleId: string | null     // null = not for a vehicle (remove the assignment)
  matchEventId?: string | null          // an expense already on that vehicle that IS this purchase (counted once)
}
export interface SetVehicleResult { ok: boolean; error?: string; already?: boolean; inventoryVehicleId?: string | null; previousVehicleId?: string | null }

export async function setReceiptVehicle(input: SetVehicleInput, actor: Actor): Promise<SetVehicleResult> {
  const db = getDb()
  if (!isUuid(input.receiptId)) return { ok: false, error: 'Receipt not found.' }
  const receipt = await getReceipt(input.receiptId)
  if (!receipt) return { ok: false, error: 'Receipt not found.' }
  const nextVehicle = input.inventoryVehicleId || null
  const nextMatch = nextVehicle ? (input.matchEventId || null) : null
  const curVehicle = receipt.inventoryVehicleId ?? null
  const curLink = await confirmedMatch(receipt.id)
  const curMatch = curVehicle ? (curLink?.eventId ?? null) : null
  if (nextVehicle === curVehicle && nextMatch === curMatch) return { ok: true, already: true, inventoryVehicleId: curVehicle, previousVehicleId: curVehicle }

  let label: string | null = null
  if (nextVehicle) {
    if (!isUuid(nextVehicle)) return { ok: false, error: 'Choose a vehicle from the list.' }
    if (receipt.status === 'rejected') return { ok: false, error: 'A rejected receipt cannot be assigned. Reopen it first.' }
    label = await vehicleLabel(nextVehicle)
    if (!label) return { ok: false, error: 'That vehicle no longer exists — pick a current inventory vehicle or leave it unassigned.' }
    const [job] = await db.select({ id: expenseAllocations.id }).from(expenseAllocations)
      .where(and(eq(expenseAllocations.receiptId, receipt.id), eq(expenseAllocations.status, 'active'), eq(expenseAllocations.target, 'job'))).limit(1)
    if (job) return { ok: false, error: 'This receipt is attached to a customer job. Remove it from the job before assigning it to a sales vehicle.' }
  }
  // A return recorded against this receipt's cost line pins it where it is.
  if (curVehicle && !curMatch && (await liveReturnsAgainst(receipt.id)) > 0) {
    return { ok: false, error: 'A return or refund is recorded against this purchase on the vehicle. Reverse that return on the vehicle first, then change the assignment.' }
  }
  if (nextMatch) {
    if (!isUuid(nextMatch)) return { ok: false, error: 'That vehicle expense could not be found.' }
    const ledger = await db.select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.inventoryVehicleId, nextVehicle as string))
    const ev = ledger.find((e) => e.id === nextMatch)
    if (!ev || !liveLedgerIds(ledger).has(ev.id) || !isRemovableVehicleExpense(ev.economicCategory)) {
      return { ok: false, error: 'That expense is no longer on this vehicle — pick again.' }
    }
    // One receipt per vehicle expense. Checked here; the purchase_links unique index is the backstop for a race.
    const [taken] = await db.select({ aId: purchaseLinks.aId }).from(purchaseLinks)
      .where(and(eq(purchaseLinks.kind, 'receipt_vehicle_event'), eq(purchaseLinks.bId, nextMatch), eq(purchaseLinks.status, 'confirmed'))).limit(1)
    if (taken && taken.aId !== receipt.id) return { ok: false, error: 'Another receipt is already matched to that vehicle expense.' }
  }

  // 1) Match first (a match without the assignment changes nothing; the reverse could briefly show two lines).
  if (curLink && curLink.eventId !== nextMatch) await clearLink(curLink.id, actor.name)
  if (nextMatch && curLink?.eventId !== nextMatch) {
    const linked = await decideLink({ kind: 'receipt_vehicle_event', aId: receipt.id, bId: nextMatch, status: 'confirmed', actor: actor.name, amountCents: receipt.totalCents, note: 'Matched when the receipt was assigned to the vehicle' })
    if (!linked.ok) {
      if (curLink) await decideLink({ kind: 'receipt_vehicle_event', aId: receipt.id, bId: curLink.eventId, status: 'confirmed', actor: actor.name, amountCents: receipt.totalCents }).catch(() => null)
      return { ok: false, error: linked.error === 'One of these is already matched to a different record. Undo that match first.' ? 'Another receipt is already matched to that vehicle expense.' : (linked.error ?? 'Could not match the receipt to that expense.') }
    }
  }
  // 2) The assignment itself — only while the row still holds the value we read (no lost update).
  if (nextVehicle !== curVehicle) {
    const done = await db.update(businessReceipts).set({ inventoryVehicleId: nextVehicle, updatedAt: new Date() })
      .where(and(eq(businessReceipts.id, receipt.id), curVehicle ? eq(businessReceipts.inventoryVehicleId, curVehicle) : isNull(businessReceipts.inventoryVehicleId)))
      .returning({ id: businessReceipts.id })
    if (done.length === 0) return { ok: false, error: 'This receipt was just changed by someone else — refresh and try again.' }
  }
  const before = curVehicle ? `${(await vehicleLabel(curVehicle)) ?? curVehicle}${curMatch ? ' (matched to an existing vehicle expense)' : ''}` : null
  const after = nextVehicle ? `${label}${nextMatch ? ' (matched to an existing vehicle expense)' : ''}` : null
  await appendReceiptAudit(receipt.id, auditEntry(nextVehicle ? 'vehicle_assigned' : 'vehicle_removed', actor.name, { inventoryVehicle: { from: before, to: after } }))
  return { ok: true, inventoryVehicleId: nextVehicle, previousVehicleId: curVehicle }
}
