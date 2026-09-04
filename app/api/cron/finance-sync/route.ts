/**
 * GET /api/cron/finance-sync
 * Server-side refresh of live Plaid data for the CFO: re-pulls read-only balances (writing a live
 * snapshot to each verified-mapped account) and ingests + classifies transactions. Runs in the
 * environment that holds the Plaid secret + token-encryption key, so it works where local scripts
 * cannot decrypt production tokens. Read-only from the bank; no money movement; no QuickBooks writes.
 *
 * Auth (see apps/finance/sync-health.ts → authorizeSync): mirrors the drain-dealer-queue cron.
 * When CRON_SECRET is set, the scheduled run must present it (Vercel Cron sends it automatically).
 * When CRON_SECRET is unset, the scheduled run falls open so daily refresh keeps working.
 * FINANCE_SYNC_TOKEN always authorizes manual/operator runs. `?diag=1` always requires a bearer.
 *
 * Every run is recorded in fin_sync_runs (source='finance_sync') — success AND failure — so a
 * broken schedule is visible instead of silent, and "last successful sync" is queryable.
 */
import { NextResponse } from 'next/server'
import { refreshPlaidBalances } from '@/apps/finance/db'
import { ingestTransactions } from '@/apps/finance/transactions'
import { discoverObligations } from '@/apps/finance/obligations-discovery'
import { deriveExpectedInflows } from '@/apps/finance/expected-inflows'
import { authorizeSync } from '@/apps/finance/sync-health'
import { getDb } from '@/platform/db'
import { finSyncRuns } from '@/apps/finance/schema'
import { eq } from 'drizzle-orm'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request) {
  const isDiag = new URL(req.url).searchParams.get('diag') === '1'
  const decision = authorizeSync(req.headers.get('authorization'), { cronSecret: process.env.CRON_SECRET, financeToken: process.env.FINANCE_SYNC_TOKEN }, isDiag)
  if (!decision.ok) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  // Guarded diagnostic: confirms which DB + how much production actually sees.
  if (isDiag) {
    const { finPlaidItems, finPlaidAccounts, finTransactions } = await import('@/apps/finance/schema')
    const { sql } = await import('drizzle-orm')
    const db = getDb()
    const [items] = await db.select({ n: sql<number>`count(*)::int` }).from(finPlaidItems)
    const [active] = await db.select({ n: sql<number>`count(*)::int` }).from(finPlaidItems).where(sql`status='active'`)
    const [accts] = await db.select({ n: sql<number>`count(*)::int` }).from(finPlaidAccounts)
    const [txs] = await db.select({ n: sql<number>`count(*)::int` }).from(finTransactions)
    const host = (process.env.DATABASE_URL ?? '').replace(/^.*@/, '').replace(/\/.*$/, '')
    return NextResponse.json({ ok: true, diag: { dbHost: host, plaidItems: items.n, activeItems: active.n, plaidAccounts: accts.n, transactions: txs.n } })
  }

  // Record the run so a failed schedule is visible (not silent) and freshness is queryable.
  const db = getDb()
  const [run] = await db.insert(finSyncRuns).values({ source: 'finance_sync', status: 'partial', actor: decision.reason }).returning({ id: finSyncRuns.id })
  try {
    const balances = await refreshPlaidBalances('cron')
    const transactions = await ingestTransactions('cron')
    const obligations = await discoverObligations('cron')
    const inflows = await deriveExpectedInflows('cron', 21)
    // Read-only QuickBooks accounting refresh (P&L / Balance Sheet / A-R / debt book balances). The
    // QBO client auto-refreshes its token and retries on 401, so the daily schedule keeps accounting
    // fresh alongside Plaid. Isolated in its own try so a QB hiccup never fails the (more critical)
    // live-cash sync — syncFromQbo records its own fin_sync_runs row (source='qbo') either way.
    let quickbooks: { ok: boolean; error?: string } = { ok: false, error: 'skipped' }
    try {
      const { syncFromQbo } = await import('@/apps/finance/qbo-sync')
      const qb = await syncFromQbo('cron')
      quickbooks = { ok: qb.ok, error: qb.error }
    } catch (e) {
      quickbooks = { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }
      logger.warn('cron:finance-sync', 'qbo_sync_failed', { error: quickbooks.error })
    }
    const summary = { balances, transactions, obligations, inflows, quickbooks }
    const anyError = (transactions.errors?.length ?? 0) > 0
    await db.update(finSyncRuns).set({ status: anyError ? 'partial' : 'ok', finishedAt: new Date(), summary: summary as any, error: anyError ? transactions.errors.join(' | ').slice(0, 500) : null }).where(eq(finSyncRuns.id, run.id))
    logger.info('cron:finance-sync', 'synced', { reason: decision.reason, ...summary })
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    await db.update(finSyncRuns).set({ status: 'error', finishedAt: new Date(), error: msg }).where(eq(finSyncRuns.id, run.id))
    logger.error('cron:finance-sync', 'failed', { error: msg })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
