/**
 * READ-ONLY mirror of QuickBooks expense entries (Purchase + Bill) → fin_qb_purchases.
 *
 * Why: receipts, checks and bank payments can only be matched to the books if the app can SEE what the books
 * already contain. This reads; it never creates, edits, voids or posts anything in QuickBooks. Fail-closed to
 * the production company (the sandbox sample company must never be mirrored as real). Runs inside the
 * existing daily QuickBooks sync and can never fail that sync.
 */
import { and, gte, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { logger } from '@/platform/logger'
import { finQbPurchases } from './schema'
import { assertCfoProductionRealm } from './qb-cfo'

const APP = 'finance:qb-purchases'
export const QB_PURCHASE_LOOKBACK_DAYS = 120

export interface QbPurchaseRow {
  qbKey: string; qbType: 'Purchase' | 'Bill'; qbId: string
  txnDate: string | null; totalCents: number
  paymentType: string | null; accountName: string | null; payeeName: string | null; payeeType: string | null
  docNumber: string | null; privateNote: string | null; lineSummary: string | null; expenseAccounts: string | null
  qbUpdatedAt: Date | null
}
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * PURE: one QuickBooks Purchase / Bill JSON object → a mirror row (null when it has no id or amount).
 * Purchase: AccountRef is the PAYING account (bank/card), EntityRef the payee, PaymentType Check|CreditCard|Cash.
 * Bill: VendorRef is the payee; there is no paying account until it is paid.
 */
type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
export function mapQbPurchase(raw: unknown, qbType: 'Purchase' | 'Bill'): QbPurchaseRow | null {
  const o = obj(raw)
  const qbId = o.Id != null ? String(o.Id) : ''
  const total = typeof o.TotalAmt === 'number' ? o.TotalAmt : parseFloat(String(o.TotalAmt ?? ''))
  if (!qbId || !Number.isFinite(total)) return null
  const lines: Obj[] = Array.isArray(o.Line) ? o.Line.map(obj) : []
  const descs = lines.map((l) => str(l.Description, 120)).filter(Boolean)
  const lineAccount = (l: Obj) => str(obj(obj(l.AccountBasedExpenseLineDetail).AccountRef).name ?? obj(obj(l.ItemBasedExpenseLineDetail).ItemRef).name, 80)
  const accts = [...new Set(lines.map(lineAccount).filter(Boolean))]
  const updatedRaw = obj(o.MetaData).LastUpdatedTime
  const updated = typeof updatedRaw === 'string' ? new Date(updatedRaw) : null
  return {
    qbKey: `${qbType}:${qbId}`, qbType, qbId,
    txnDate: typeof o.TxnDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.TxnDate) ? o.TxnDate : null,
    totalCents: Math.round(Math.abs(total) * 100),
    paymentType: qbType === 'Purchase' ? str(o.PaymentType, 24) : null,
    accountName: qbType === 'Purchase' ? str(obj(o.AccountRef).name, 200) : null,
    payeeName: str(obj(qbType === 'Purchase' ? o.EntityRef : o.VendorRef).name, 200),
    payeeType: qbType === 'Purchase' ? str(obj(o.EntityRef).type, 16) : 'Vendor',
    docNumber: str(o.DocNumber, 60), privateNote: str(o.PrivateNote, 500),
    lineSummary: descs.length ? descs.join(' · ').slice(0, 500) : null,
    expenseAccounts: accts.length ? accts.join(' · ').slice(0, 300) : null,
    qbUpdatedAt: updated && !Number.isNaN(updated.getTime()) ? updated : null,
  }
}

export interface QbPurchaseSyncResult { ok: boolean; skipped?: string; purchases?: number; bills?: number; markedMissing?: number; since?: string }

/** Pull the last QB_PURCHASE_LOOKBACK_DAYS of Purchases + Bills and upsert the mirror. Read-only toward QuickBooks. */
export async function persistQbPurchases(now: Date = new Date()): Promise<QbPurchaseSyncResult> {
  const { getValidAccessToken } = await import('@/apps/quickbooks/connection')
  const { queryQBO } = await import('@/apps/quickbooks/client')
  let realmId = '', environment = ''
  try { const tok = await getValidAccessToken(); realmId = tok.realmId; environment = tok.environment } catch { return { ok: false, skipped: 'no active QuickBooks connection' } }
  const gate = assertCfoProductionRealm(realmId, environment)
  if (!gate.ok) return { ok: false, skipped: `non-production realm rejected: ${gate.reason}` }

  const since = new Date(now.getTime() - QB_PURCHASE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
  const [p, b] = await Promise.all([
    queryQBO<{ Purchase?: unknown[] }>(`SELECT * FROM Purchase WHERE TxnDate >= '${since}' ORDERBY TxnDate DESC MAXRESULTS 1000`),
    queryQBO<{ Bill?: unknown[] }>(`SELECT * FROM Bill WHERE TxnDate >= '${since}' ORDERBY TxnDate DESC MAXRESULTS 1000`),
  ])
  const rows = [
    ...(p.Purchase ?? []).map((r) => mapQbPurchase(r, 'Purchase')),
    ...(b.Bill ?? []).map((r) => mapQbPurchase(r, 'Bill')),
  ].filter((r): r is QbPurchaseRow => r !== null)
  const db = getDb()
  for (const r of rows) {
    await db.insert(finQbPurchases).values({ ...r, firstSeenAt: now, lastSeenAt: now, missingSince: null })
      .onConflictDoUpdate({ target: finQbPurchases.qbKey, set: { ...r, lastSeenAt: now, missingSince: null } })
  }
  // An entry inside the window that QuickBooks no longer returns was deleted or voided there. Keep the row
  // (history + any confirmed match) but mark it so it stops counting. Skipped if a page was truncated.
  let markedMissing = 0
  const truncated = (p.Purchase ?? []).length >= 1000 || (b.Bill ?? []).length >= 1000
  if (!truncated) {
    const keys = rows.map((r) => r.qbKey)
    const gone = await db.update(finQbPurchases).set({ missingSince: now })
      .where(and(gte(finQbPurchases.txnDate, since), isNull(finQbPurchases.missingSince), keys.length ? notInArray(finQbPurchases.qbKey, keys) : sql`true`))
      .returning({ k: finQbPurchases.qbKey })
    markedMissing = gone.length
  }
  logger.info(APP, 'synced', { purchases: (p.Purchase ?? []).length, bills: (b.Bill ?? []).length, markedMissing })
  return { ok: true, purchases: (p.Purchase ?? []).length, bills: (b.Bill ?? []).length, markedMissing, since }
}

/** Mirror rows for a set of keys (used when showing a confirmed match). */
export async function getQbPurchases(keys: string[]) {
  if (keys.length === 0) return []
  return getDb().select().from(finQbPurchases).where(inArray(finQbPurchases.qbKey, keys))
}
