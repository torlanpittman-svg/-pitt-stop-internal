/**
 * CFO sync health + finance-sync auth policy.
 *
 * Two concerns, kept together because both answer "can I trust today's number?":
 *   1. authorizeSync — the finance-sync endpoint's auth decision, mirroring the proven
 *      drain-dealer-queue cron: when CRON_SECRET is set we require it (Vercel Cron sends it
 *      automatically); when it is NOT set the scheduled sync falls open so daily refresh keeps
 *      working. FINANCE_SYNC_TOKEN always authorizes manual/operator runs. Diagnostics (which
 *      reveal infra like the DB host) ALWAYS require an explicit valid bearer.
 *   2. classifyFreshness / getSyncHealth — turns the last successful source refresh into a
 *      FRESH | STALE | FAILED verdict so a stale bank balance can never be presented as current.
 *
 * The auth + classify functions are pure so they unit-test without a DB or network.
 * Read-only toward the bank; no money movement.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finPlaidItems, finPlaidAccounts, finSyncRuns } from './schema'

// ── Auth policy ───────────────────────────────────────────────────────────────
export interface SyncAuthEnv { cronSecret?: string | null; financeToken?: string | null }
export interface SyncAuthDecision { ok: boolean; reason: 'diag:bearer' | 'diag:denied' | 'sync:bearer' | 'sync:denied' | 'sync:open' }

/** Decide whether a finance-sync request is authorized. Pure — no env access, no I/O. */
export function authorizeSync(authHeader: string | null | undefined, env: SyncAuthEnv, isDiag: boolean): SyncAuthDecision {
  const auth = authHeader ?? ''
  const bearerMatches =
    (Boolean(env.cronSecret) && auth === `Bearer ${env.cronSecret}`) ||
    (Boolean(env.financeToken) && auth === `Bearer ${env.financeToken}`)
  // Diagnostics expose infrastructure details → always require an explicit valid bearer.
  if (isDiag) return { ok: bearerMatches, reason: bearerMatches ? 'diag:bearer' : 'diag:denied' }
  // Sync action: if a CRON_SECRET is configured, require a valid bearer (Vercel Cron sends it).
  if (env.cronSecret) return { ok: bearerMatches, reason: bearerMatches ? 'sync:bearer' : 'sync:denied' }
  // No CRON_SECRET configured → fall open for the scheduled sync (parity with drain-dealer-queue),
  // so daily refresh works until the owner hardens it by setting CRON_SECRET.
  return { ok: true, reason: bearerMatches ? 'sync:bearer' : 'sync:open' }
}

// ── Freshness policy ────────────────────────────────────────────────────────────
export type FreshnessStatus = 'fresh' | 'stale' | 'failed' | 'unknown'
// Cron cadence is daily (Vercel plan limit): a full day plus a grace window is still FRESH.
export const FRESH_MAX_HOURS = 30

export interface SyncHealth {
  status: FreshnessStatus
  lastSuccessAt: string | null   // last time every active source was refreshed
  ageHours: number | null
  lastRunStatus: string | null   // 'ok' | 'error' | 'partial' | null (from fin_sync_runs)
  lastError: string | null
  balanceAsOf: string | null
  message: string
}

/** Pure classifier: given the last successful refresh + last run status, return the verdict. */
export function classifyFreshness(
  lastSuccessAt: Date | string | null,
  lastRunStatus: string | null,
  lastError: string | null,
  now: Date = new Date(),
): { status: FreshnessStatus; ageHours: number | null } {
  const t = lastSuccessAt ? new Date(lastSuccessAt).getTime() : null
  const ageHours = t == null || Number.isNaN(t) ? null : (now.getTime() - t) / 3_600_000
  let status: FreshnessStatus
  if (ageHours == null) status = 'unknown'
  else if (ageHours <= FRESH_MAX_HOURS) status = 'fresh'
  else status = 'stale'
  // A failed most-recent run is surfaced as FAILED unless a later success already made us fresh
  // (recovered). Never let a failure masquerade as fresh, and never silently zero the balance.
  if (lastRunStatus === 'error' && status !== 'fresh') status = 'failed'
  return { status, ageHours }
}

function freshnessMessage(status: FreshnessStatus, ageHours: number | null, lastError: string | null): string {
  const age = ageHours == null ? 'never' : ageHours < 1 ? `${Math.round(ageHours * 60)} min ago` : ageHours < 48 ? `${Math.round(ageHours)}h ago` : `${Math.round(ageHours / 24)} days ago`
  switch (status) {
    case 'fresh':   return `Bank data is current (last verified sync ${age}).`
    case 'stale':   return `Bank data is STALE — last verified sync ${age}. Figures below reflect that last snapshot, not this moment. Run a sync before spending decisions.`
    case 'failed':  return `Last finance sync FAILED${lastError ? ` (${lastError.slice(0, 120)})` : ''}. Showing the last verified snapshot from ${age} — treat as out of date.`
    default:        return 'No verified bank sync yet — cash figures cannot be trusted as current.'
  }
}

/**
 * DB-backed sync health. "Last successful refresh" = the OLDEST last-sync across ACTIVE Plaid items
 * (if any source is behind, we are only as fresh as the laggard). Run status/errors come from the
 * finance_sync run log so a failed scheduled run is visible instead of silent.
 */
export async function getSyncHealth(now: Date = new Date()): Promise<SyncHealth> {
  const db = getDb()
  // Oldest transactions_synced_at among active items = the conservative "everything refreshed" time.
  const items = await db.select().from(finPlaidItems).where(eq(finPlaidItems.status, 'active'))
  const syncTimes = items.map((i) => i.transactionsSyncedAt).filter((d): d is Date => d != null).map((d) => new Date(d).getTime())
  const lastSuccess = syncTimes.length ? new Date(Math.min(...syncTimes)) : null
  // Oldest live balance as-of among active, verified-mapped accounts.
  const activeAccts = await db.select({ asOf: finPlaidAccounts.balanceAsOf })
    .from(finPlaidAccounts)
    .where(and(eq(finPlaidAccounts.status, 'active'), eq(finPlaidAccounts.mappingVerified, true)))
  const balTimes = activeAccts.map((a) => a.asOf).filter((d): d is Date => d != null).map((d) => new Date(d).getTime())
  const balanceAsOf = balTimes.length ? new Date(Math.min(...balTimes)) : null
  // Latest finance_sync run (records success AND failure once deployed).
  const [lastRun] = await db.select().from(finSyncRuns)
    .where(inArray(finSyncRuns.source, ['finance_sync', 'plaid']))
    .orderBy(desc(finSyncRuns.startedAt)).limit(1)

  const { status, ageHours } = classifyFreshness(lastSuccess, lastRun?.status ?? null, lastRun?.error ?? null, now)
  return {
    status,
    lastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
    ageHours,
    lastRunStatus: lastRun?.status ?? null,
    lastError: lastRun?.error ?? null,
    balanceAsOf: balanceAsOf ? balanceAsOf.toISOString() : null,
    message: freshnessMessage(status, ageHours, lastRun?.error ?? null),
  }
}
