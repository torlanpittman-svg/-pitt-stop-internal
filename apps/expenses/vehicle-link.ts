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
import { decideLink, clearLink, vehicleMatchAtRisk, type VehicleMatchRisk } from '@/apps/finance/purchase-links'
import { removeVehicleExpense } from '@/apps/auto-sales/db'
import { businessReceipts, expenseAllocations } from './schema'
import { appendReceiptAudit, getReceipt } from './db'
import { auditEntry } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)
const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`)
const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

export interface Actor { name: string | null; key?: string | null }

export async function vehicleLabel(inventoryVehicleId: string): Promise<string | null> {
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
  // "Matched" only while the match is doing its job: the expense is a live line on the vehicle the receipt is on.
  const atRisk = curLink ? await vehicleMatchAtRisk({ id: curLink.id, kind: 'receipt_vehicle_event', aId: receipt.id, bId: curLink.eventId, status: 'confirmed' }) : null
  const curMatch = atRisk ? atRisk.eventId : null
  if (nextVehicle === curVehicle && nextMatch === curMatch) return { ok: true, already: true, inventoryVehicleId: curVehicle, previousVehicleId: curVehicle }

  // A matched receipt is counted as the expense already typed on its vehicle. The only change allowed from
  // here is taking it off the vehicle (the typed expense keeps counting, once). Moving it to another vehicle,
  // re-matching it, or un-matching it in place would count the purchase twice — that needs an explicit
  // resolution (resolveVehicleMatch), never a side effect of an assignment.
  if (curMatch && nextVehicle) {
    return { ok: false, error: 'This receipt is counted as an expense already entered on its vehicle. Remove the receipt from that vehicle first (the entered expense stays and keeps counting once), or resolve the match on the Finance reconcile page.' }
  }

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

  // Order matters (no transactions): at no point may the receipt and a matched expense both count.
  if (!nextVehicle) {
    // Taking it off the vehicle: clear the assignment FIRST (the receipt stops counting; a matched expense keeps
    // counting, once), then retire the match — which is no longer protecting anything.
    const done = await db.update(businessReceipts).set({ inventoryVehicleId: null, updatedAt: new Date() })
      .where(and(eq(businessReceipts.id, receipt.id), eq(businessReceipts.inventoryVehicleId, curVehicle as string))).returning({ id: businessReceipts.id })
    if (done.length === 0) return { ok: false, error: 'This receipt was just changed by someone else — refresh and try again.' }
    if (curLink) await clearLink(curLink.id, actor.name, { vehicleSplit: 'assignment_change' })
  } else {
    // Assigning (curMatch is null here): a leftover match to a removed expense is retired, a new match is saved
    // BEFORE the assignment (a match without the assignment changes nothing), then the assignment itself.
    if (curLink && curLink.eventId !== nextMatch) await clearLink(curLink.id, actor.name, { vehicleSplit: 'assignment_change' })
    if (nextMatch && curLink?.eventId !== nextMatch) {
      const linked = await decideLink({ kind: 'receipt_vehicle_event', aId: receipt.id, bId: nextMatch, status: 'confirmed', actor: actor.name, amountCents: receipt.totalCents, note: 'Matched when the receipt was assigned to the vehicle' })
      if (!linked.ok) return { ok: false, error: linked.error === 'One of these is already matched to a different record. Undo that match first.' ? 'Another receipt is already matched to that vehicle expense.' : (linked.error ?? 'Could not match the receipt to that expense.') }
    }
    if (nextVehicle !== curVehicle) {
      const done = await db.update(businessReceipts).set({ inventoryVehicleId: nextVehicle, updatedAt: new Date() })
        .where(and(eq(businessReceipts.id, receipt.id), curVehicle ? eq(businessReceipts.inventoryVehicleId, curVehicle) : isNull(businessReceipts.inventoryVehicleId)))
        .returning({ id: businessReceipts.id })
      if (done.length === 0) return { ok: false, error: 'This receipt was just changed by someone else — refresh and try again.' }
    }
  }
  const before = curVehicle ? `${(await vehicleLabel(curVehicle)) ?? curVehicle}${curMatch ? ' (matched to an existing vehicle expense)' : ''}` : null
  const after = nextVehicle ? `${label}${nextMatch ? ' (matched to an existing vehicle expense)' : ''}` : null
  await appendReceiptAudit(receipt.id, auditEntry(nextVehicle ? 'vehicle_assigned' : 'vehicle_removed', actor.name, { inventoryVehicle: { from: before, to: after } }))
  return { ok: true, inventoryVehicleId: nextVehicle, previousVehicleId: curVehicle }
}

// ── Resolving a match that is keeping ONE purchase from counting twice on a vehicle ──────────────────
export const MATCH_RESOLUTIONS = ['keep_matched', 'different_purchases', 'remove_duplicate'] as const
export type MatchResolution = (typeof MATCH_RESOLUTIONS)[number]
export function isMatchResolution(v: unknown): v is MatchResolution { return typeof v === 'string' && (MATCH_RESOLUTIONS as readonly string[]).includes(v) }
export interface ResolveResult { ok: boolean; error?: string; resolution?: MatchResolution; inventoryVehicleId?: string }

/** What the reconcile page shows before asking: the vehicle, both amounts, and what each choice does. */
export interface VehicleMatchRiskView extends VehicleMatchRisk { vehicleLabel: string; canRemoveDuplicate: boolean; removeBlockedWhy: string | null }
export async function describeVehicleMatchRisk(risk: VehicleMatchRisk): Promise<VehicleMatchRiskView> {
  const why = await duplicateRemovalBlocked(risk)
  return { ...risk, vehicleLabel: (await vehicleLabel(risk.inventoryVehicleId)) ?? 'the vehicle', canRemoveDuplicate: !why, removeBlockedWhy: why }
}

/** Why the typed vehicle expense cannot be removed as the duplicate (null = it can). */
async function duplicateRemovalBlocked(risk: VehicleMatchRisk): Promise<string | null> {
  const ledger = await getDb().select().from(vehicleFinancialEvents).where(eq(vehicleFinancialEvents.inventoryVehicleId, risk.inventoryVehicleId))
  const ev = ledger.find((e) => e.id === risk.eventId)
  if (!ev) return 'That vehicle expense no longer exists.'
  if (!isRemovableVehicleExpense(ev.economicCategory)) return 'That entry is not a removable vehicle expense.'
  if (ev.status === 'reconciled' || ev.finTransactionId) return 'The vehicle expense is linked to a reconciled bank/accounting record — ask the accountant to unlink it first.'
  const live = liveLedgerIds(ledger)
  if (ledger.some((e) => e.originalEventId === ev.id && live.has(e.id))) return 'A return or refund is recorded against the vehicle expense. Reverse that return on the vehicle first.'
  return null
}

/**
 * A person's explicit answer to "this receipt and this vehicle expense are matched on the same vehicle — what
 * now?". The ONLY way such a match is separated (purchase-links refuses a plain undo / "not the same").
 *
 *   keep_matched        — nothing changes; the purchase keeps counting once.
 *   different_purchases — confirmed as two real purchases: the match is retired and the pair is recorded as
 *                         "not the same" (so it is never suggested or flagged again). BOTH now count.
 *   remove_duplicate    — the TYPED vehicle expense is the redundant copy: it is reversed through the existing
 *                         correction (removeVehicleExpense — append-only, original kept in History) and the
 *                         receipt carries the purchase from then on. Still counted once.
 *
 * Nothing is deleted. Recorded in fin_events (the match), the vehicle ledger (the correction) and the receipt's
 * audit trail. No QuickBooks call, no money movement.
 */
export async function resolveVehicleMatch(linkId: string, resolution: MatchResolution, actor: Actor): Promise<ResolveResult> {
  if (!isMatchResolution(resolution)) return { ok: false, error: 'Choose how to resolve this match.' }
  if (!isUuid(linkId)) return { ok: false, error: 'Match not found.' }
  const db = getDb()
  const [link] = await db.select().from(purchaseLinks).where(eq(purchaseLinks.id, linkId)).limit(1)
  if (!link || link.kind !== 'receipt_vehicle_event') return { ok: false, error: 'Match not found.' }
  if (link.status !== 'confirmed') return { ok: false, error: 'That match was already changed — refresh and try again.' }
  const risk = await vehicleMatchAtRisk(link)
  if (!risk) return { ok: false, error: 'This match no longer involves a receipt and an expense on the same vehicle — refresh and use the normal undo.' }
  if (resolution === 'keep_matched') return { ok: true, resolution, inventoryVehicleId: risk.inventoryVehicleId }

  const label = (await vehicleLabel(risk.inventoryVehicleId)) ?? 'the vehicle'
  if (resolution === 'different_purchases') {
    const r = await decideLink({ kind: 'receipt_vehicle_event', aId: risk.receiptId, bId: risk.eventId, status: 'dismissed', actor: actor.name, vehicleSplit: 'different_purchases',
      note: 'Confirmed as two different purchases — both count on the vehicle' })
    if (!r.ok) return { ok: false, error: r.error ?? 'Could not record the decision.' }
    await appendReceiptAudit(risk.receiptId, auditEntry('vehicle_match_resolved', actor.name, { vehicleMatch: { from: 'counted once with an expense already on the vehicle', to: 'a different purchase — counts on its own' } },
      `Different purchases on ${label}: this receipt (${money(risk.receiptCents)}) and the entered vehicle expense (${money(risk.eventCents)}) both count.`))
    return { ok: true, resolution, inventoryVehicleId: risk.inventoryVehicleId }
  }

  // remove_duplicate
  const blocked = await duplicateRemovalBlocked(risk)
  if (blocked) return { ok: false, error: blocked }
  // The match stays in place while the typed expense is reversed, so there is never a moment with two lines:
  // before → the typed expense counts; after → it is reversed and the receipt counts.
  const removed = await removeVehicleExpense({ eventId: risk.eventId, actor: actor.name, duplicateOfReceiptId: risk.receiptId })
  if (!removed.ok) return { ok: false, error: removed.error ?? 'Could not remove the vehicle expense.' }
  await clearLink(link.id, actor.name, { vehicleSplit: 'duplicate_removed' })
  await appendReceiptAudit(risk.receiptId, auditEntry('vehicle_match_resolved', actor.name, { vehicleMatch: { from: 'counted once with an expense already on the vehicle', to: 'counts on its own — the duplicate vehicle expense was removed' } },
    `Duplicate removed on ${label}: the entered vehicle expense (${money(risk.eventCents)}) was reversed; this receipt (${money(risk.receiptCents)}) now carries the purchase.`))
  return { ok: true, resolution, inventoryVehicleId: risk.inventoryVehicleId }
}
