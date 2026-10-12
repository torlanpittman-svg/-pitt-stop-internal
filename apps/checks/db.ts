/**
 * Check persistence + audit. The ONLY writers of the checks / check_events / check_sequence tables.
 * Every state transition is recorded in check_events (append-only) so the full history — created,
 * recorded, print, print_failed, reprinted, void-requested — is always reconstructable.
 */
import { getDb } from '@/platform/db'
import { desc, eq, sql } from 'drizzle-orm'
import { checks, checkEvents } from './schema'
import { getCheckConfig } from './config'
import type { CheckView, QbStatus, PrintStatus, BankKey, CheckCategoryKey } from './types'
import { categoryDef } from './types'

type CheckRow = typeof checks.$inferSelect

export async function logCheckEvent(checkId: string, action: string, actor: string | null, detail?: unknown): Promise<void> {
  await getDb().insert(checkEvents).values({ checkId, action, actor, detail: detail ?? null })
}

export interface InsertCheckInput {
  checkNumber: number
  bankKey: BankKey
  bankQboAccountId: string
  payeeName: string
  payeeQboVendorId: string | null
  amountCents: number
  memo: string | null
  category: CheckCategoryKey
  expenseQboAccountId: string
  entity: 'operating' | 'auto_sales'
  linkedJobId: string | null
  linkedVehicleId: string | null
  checkDate: string
  idempotencyKey: string
  actorKey: string | null
  actorName: string | null
}

export async function insertCheck(input: InsertCheckInput): Promise<string> {
  const [row] = await getDb().insert(checks).values({
    checkNumber: input.checkNumber,
    bankKey: input.bankKey,
    bankQboAccountId: input.bankQboAccountId,
    payeeName: input.payeeName,
    payeeQboVendorId: input.payeeQboVendorId,
    amountCents: input.amountCents,
    memo: input.memo,
    category: input.category,
    expenseQboAccountId: input.expenseQboAccountId,
    entity: input.entity,
    linkedJobId: input.linkedJobId,
    linkedVehicleId: input.linkedVehicleId,
    checkDate: input.checkDate,
    idempotencyKey: input.idempotencyKey,
    actorKey: input.actorKey,
    actorName: input.actorName,
  }).returning({ id: checks.id })
  return row.id
}

export async function getCheckRow(id: string): Promise<CheckRow | null> {
  const [row] = await getDb().select().from(checks).where(eq(checks.id, id)).limit(1)
  return row ?? null
}

export async function getCheckByIdempotencyKey(key: string): Promise<CheckRow | null> {
  const [row] = await getDb().select().from(checks).where(eq(checks.idempotencyKey, key)).limit(1)
  return row ?? null
}

export async function markRecorded(id: string, qbo: { txnId: string; docNumber: string | null; syncToken: string; realmId: string | null }): Promise<void> {
  await getDb().update(checks).set({
    qboTxnId: qbo.txnId, qboDocNumber: qbo.docNumber, qboSyncToken: qbo.syncToken, realmId: qbo.realmId,
    qbStatus: 'recorded', qbError: null, updatedAt: new Date(),
  }).where(eq(checks.id, id))
}

/**
 * Take the exclusive right to perform the QuickBooks write for a check. Single-statement compare-and-set:
 * exactly one caller wins while the check is pending/failed; everyone else gets false and must NOT call
 * QuickBooks. A lock abandoned by a crashed request (still 'writing' after QB_LOCK_STALE_SECONDS) can be
 * re-taken — the retry then looks the check up in QuickBooks before creating anything.
 */
export const QB_LOCK_STALE_SECONDS = 180
export async function acquireQbWriteLock(id: string): Promise<boolean> {
  const res = await getDb().execute(sql`
    UPDATE checks SET qb_status = 'writing', updated_at = now()
     WHERE id = ${id}::uuid AND qbo_txn_id IS NULL
       AND (qb_status IN ('pending', 'failed')
            OR (qb_status = 'writing' AND updated_at < now() - interval '${sql.raw(String(QB_LOCK_STALE_SECONDS))} seconds'))
    RETURNING id
  `)
  const rows = (res as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])
  return Array.isArray(rows) && rows.length > 0
}

export async function markQbFailed(id: string, error: string): Promise<void> {
  await getDb().update(checks).set({ qbStatus: 'failed', qbError: error.slice(0, 4000), updatedAt: new Date() }).where(eq(checks.id, id))
}

export async function setPrintStatus(id: string, status: PrintStatus, opts: { bumpReprint?: boolean } = {}): Promise<CheckRow | null> {
  const patch: Record<string, unknown> = { printStatus: status, updatedAt: new Date() }
  if (status === 'printed') patch.printedAt = new Date()
  if (opts.bumpReprint) patch.reprintCount = sql`${checks.reprintCount} + 1`
  const [row] = await getDb().update(checks).set(patch).where(eq(checks.id, id)).returning()
  return row ?? null
}

export async function setQbStatus(id: string, status: QbStatus): Promise<void> {
  await getDb().update(checks).set({ qbStatus: status, updatedAt: new Date() }).where(eq(checks.id, id))
}

export async function listRecentChecks(limit = 50): Promise<CheckView[]> {
  const rows = await getDb().select().from(checks).orderBy(desc(checks.createdAt)).limit(limit)
  const cfg = await getCheckConfig()
  return rows.map((r) => toView(r, cfg.banks[r.bankKey as BankKey]?.label ?? r.bankKey))
}

export async function checkEventHistory(checkId: string) {
  return getDb().select().from(checkEvents).where(eq(checkEvents.checkId, checkId)).orderBy(desc(checkEvents.createdAt))
}

/** Map a DB row to the client-safe view (no bank account NUMBER is stored on the row, only the QBO
 *  Account.Id reference, so nothing sensitive leaks). */
export function toView(r: CheckRow, bankLabel: string): CheckView {
  return {
    id: r.id,
    checkNumber: r.checkNumber,
    bankKey: r.bankKey as BankKey,
    bankLabel,
    payeeName: r.payeeName,
    amountCents: r.amountCents,
    memo: r.memo,
    category: r.category as CheckCategoryKey,
    categoryLabel: categoryDef(r.category)?.label ?? r.category,
    entity: r.entity as 'operating' | 'auto_sales',
    linkedJobId: r.linkedJobId,
    linkedVehicleId: r.linkedVehicleId,
    checkDate: typeof r.checkDate === 'string' ? r.checkDate : String(r.checkDate),
    qboTxnId: r.qboTxnId,
    qboDocNumber: r.qboDocNumber,
    qbStatus: r.qbStatus as QbStatus,
    qbError: r.qbError,
    printStatus: r.printStatus as PrintStatus,
    printedAt: r.printedAt ? r.printedAt.toISOString() : null,
    reprintCount: r.reprintCount,
    actorName: r.actorName,
    createdAt: r.createdAt.toISOString(),
  }
}

/** Convenience: view for one id (or null). */
export async function getCheckView(id: string): Promise<CheckView | null> {
  const row = await getCheckRow(id)
  if (!row) return null
  const cfg = await getCheckConfig()
  return toView(row, cfg.banks[row.bankKey as BankKey]?.label ?? row.bankKey)
}
