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
export interface LinkResult { ok: boolean; error?: string; id?: string; already?: boolean }

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
  if (input.status === 'confirmed') {
    for (const [type, id] of [[spec.aType, input.aId], [spec.bType, input.bId]] as [RecordType, string][]) {
      const err = await checkRecord(type, id)
      if (err) return { ok: false, error: err }
    }
  }
  if (live) await db.update(purchaseLinks).set({ status: 'cleared', clearedBy: input.actor, clearedAt: new Date() }).where(and(eq(purchaseLinks.id, live.id), ne(purchaseLinks.status, 'cleared')))
  try {
    const [row] = await db.insert(purchaseLinks).values({
      kind: input.kind, aType: spec.aType, aId: input.aId, bType: spec.bType, bId: input.bId, status: input.status,
      amountCents: input.amountCents ?? null, evidence: (input.evidence ?? null) as object | null, note: input.note?.trim() || null, decidedBy: input.actor,
    }).returning({ id: purchaseLinks.id })
    await audit(input.status === 'confirmed' ? 'confirm' : 'dismiss', { id: row.id, kind: input.kind, aId: input.aId, bId: input.bId }, input.actor, { evidence: input.evidence ?? null })
    return { ok: true, id: row.id }
  } catch (err) {
    if (!uniqueViolation(err)) throw err
    // Restore the decision we just cleared, then explain: one side already has a confirmed partner.
    if (live) await db.update(purchaseLinks).set({ status: live.status, clearedBy: null, clearedAt: null }).where(eq(purchaseLinks.id, live.id)).catch(() => {})
    return { ok: false, error: 'One of these is already matched to a different record. Undo that match first.' }
  }
}

/** Undo a decision. The row is kept with status 'cleared' (history), and the pair returns to the suggestions. */
export async function clearLink(id: string, actor: string | null): Promise<LinkResult> {
  if (!UUID.test(id)) return { ok: false, error: 'Match not found.' }
  const db = getDb()
  const [row] = await db.select().from(purchaseLinks).where(eq(purchaseLinks.id, id)).limit(1)
  if (!row) return { ok: false, error: 'Match not found.' }
  if (row.status === 'cleared') return { ok: true, id, already: true }
  await db.update(purchaseLinks).set({ status: 'cleared', clearedBy: actor, clearedAt: new Date() }).where(and(eq(purchaseLinks.id, id), ne(purchaseLinks.status, 'cleared')))
  await audit('clear', row, actor, { was: row.status })
  return { ok: true, id }
}

/** Every live (confirmed or dismissed) decision, optionally for some kinds. Cleared rows are history only. */
export async function liveLinks(kinds?: LinkKind[]): Promise<LinkRow[]> {
  const conds = [ne(purchaseLinks.status, 'cleared')]
  if (kinds?.length) conds.push(inArray(purchaseLinks.kind, kinds))
  return getDb().select().from(purchaseLinks).where(and(...conds))
}
