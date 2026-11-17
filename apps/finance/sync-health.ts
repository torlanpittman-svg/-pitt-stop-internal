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
import { finAccounts, finPlaidItems, finPlaidAccounts, finSyncRuns } from './schema'

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
  /** Every connected bank/card account, each with its own verdict — one healthy bank never hides a broken one. */
  sources: SourceHealth[]
}

// ── Per-connection health ───────────────────────────────────────────────────────
export interface SourceInput {
  label: string                    // e.g. "Pitt Stop Auto Sales *5600"
  institution: string | null
  operating: boolean               // the account Safe-to-Spend is computed from
  itemStatus: string               // active | error | disconnected
  lastError: string | null
  balanceAsOf: Date | string | null
}
export interface SourceHealth {
  label: string; institution: string | null; operating: boolean
  state: 'ok' | 'stale' | 'error'
  asOf: string | null; ageHours: number | null
  detail: string                   // plain English, safe to show
}
const ageText = (h: number | null) => (h == null ? 'never' : h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`)

/** The bank's own reason, without route names or error codes: "…: this institution is not currently responding to this request. please…" → that first sentence. */
function bankSaid(err: string | null): string {
  if (!err) return ''
  const text = err.replace(/^finance:plaid\s+\S+\s+→\s+/, '').replace(/^[A-Z_]{4,}:\s*/, '').split(/\.\s/)[0].replace(/\.$/, '').trim().slice(0, 110)
  return text ? ` (the bank said: “${text}”)` : ''
}

/** PURE: one connection's verdict. A connection in error is 'error' however recent its last good balance. */
export function classifySource(src: SourceInput, now: Date = new Date()): SourceHealth {
  const t = src.balanceAsOf ? new Date(src.balanceAsOf).getTime() : null
  const ageHours = t == null || Number.isNaN(t) ? null : (now.getTime() - t) / 3_600_000
  const base = { label: src.label, institution: src.institution, operating: src.operating, asOf: t == null || Number.isNaN(t) ? null : new Date(t).toISOString(), ageHours }
  if (src.itemStatus !== 'active') {
    return { ...base, state: 'error', detail: `${src.label} is not updating — the bank connection ${src.itemStatus === 'disconnected' ? 'is disconnected' : 'failed'}${bankSaid(src.lastError)}. Its balance was last read ${ageText(ageHours)}.` }
  }
  if (ageHours == null || ageHours > FRESH_MAX_HOURS) return { ...base, state: 'stale', detail: `${src.label} was last read ${ageText(ageHours)}.` }
  return { ...base, state: 'ok', detail: `${src.label} is current (read ${ageText(ageHours)}).` }
}

/** PURE: fold the operating verdict and the other connections into the banner status + message. */
export function overallHealth(operatingStatus: FreshnessStatus, operatingMessage: string, sources: SourceHealth[]): { status: FreshnessStatus; message: string } {
  const op = sources.find((x) => x.operating)
  const others = sources.filter((x) => !x.operating && x.state !== 'ok')
  let status = operatingStatus, message = operatingMessage
  if (op && op.state === 'error') { status = 'failed'; message = op.detail }
  if (others.length) {
    if (status === 'fresh') status = 'stale'
    message = `${status === 'stale' && operatingStatus === 'fresh' ? 'Operating account is current, but: ' : `${message} Also: `}${others.map((o) => o.detail).join(' ')}`
  }
  return { status, message }
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
 * DB-backed sync health. The headline verdict follows the OPERATING account's bank (that is what
 * Safe-to-Spend is computed from), and every other connected bank/card is reported in `sources` — a
 * connection that is failing is surfaced even though the scheduled run that skipped it said "ok".
 */
export async function getSyncHealth(now: Date = new Date()): Promise<SyncHealth> {
  const db = getDb()
  const items = await db.select().from(finPlaidItems)
  const accts = await db.select({ pa: finPlaidAccounts, fa: finAccounts }).from(finPlaidAccounts)
    .leftJoin(finAccounts, eq(finPlaidAccounts.mappedAccountId, finAccounts.id))
    .where(and(eq(finPlaidAccounts.status, 'active'), eq(finPlaidAccounts.mappingVerified, true)))
  const itemById = new Map(items.map((i) => [i.id, i]))
  const isOperating = (a: (typeof accts)[number]) => /2649/.test(a.fa?.name ?? '') || /2649/.test(a.pa.mask ?? '')
  const sources = accts.map((a) => {
    const it = itemById.get(a.pa.itemId)
    return classifySource({ label: a.fa?.name ?? `${a.pa.name ?? 'Account'}${a.pa.mask ? ` *${a.pa.mask}` : ''}`, institution: it?.institutionName ?? null, operating: isOperating(a), itemStatus: it?.status ?? 'disconnected', lastError: it?.lastError ?? null, balanceAsOf: a.pa.balanceAsOf }, now)
  })
  // "Last successful refresh" for the operating verdict = the operating account's own bank.
  const opAcct = accts.find(isOperating)
  const opItem = opAcct ? itemById.get(opAcct.pa.itemId) : undefined
  const lastSuccess = opItem?.transactionsSyncedAt ? new Date(opItem.transactionsSyncedAt) : null
  const balanceAsOf = opAcct?.pa.balanceAsOf ? new Date(opAcct.pa.balanceAsOf) : null
  // Latest finance_sync run (records success AND failure).
  const [lastRun] = await db.select().from(finSyncRuns)
    .where(inArray(finSyncRuns.source, ['finance_sync', 'plaid']))
    .orderBy(desc(finSyncRuns.startedAt)).limit(1)

  const { status, ageHours } = classifyFreshness(lastSuccess, lastRun?.status ?? null, lastRun?.error ?? null, now)
  const overall = overallHealth(status, freshnessMessage(status, ageHours, lastRun?.error ?? null), sources)
  return {
    status: overall.status,
    lastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
    ageHours,
    lastRunStatus: lastRun?.status ?? null,
    lastError: lastRun?.error ?? null,
    balanceAsOf: balanceAsOf ? balanceAsOf.toISOString() : null,
    message: overall.message,
    sources,
  }
}
