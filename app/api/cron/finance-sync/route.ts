/**
 * GET /api/cron/finance-sync
 * Server-side refresh of live Plaid data for the CFO: re-pulls read-only balances (writing a live
 * snapshot to each verified-mapped account) and ingests + classifies transactions. Runs in the
 * environment that holds the Plaid secret + token-encryption key, so it works where local scripts
 * cannot decrypt production tokens. Read-only from the bank; no money movement; no QuickBooks writes.
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET|FINANCE_SYNC_TOKEN>`. Vercel Cron sends
 * CRON_SECRET automatically; FINANCE_SYNC_TOKEN is an owner/operator token for manual/verification
 * runs. If neither env var is set (local dev) it runs open.
 */
import { NextResponse } from 'next/server'
import { refreshPlaidBalances } from '@/apps/finance/db'
import { ingestTransactions } from '@/apps/finance/transactions'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request) {
  const accepted = [process.env.CRON_SECRET, process.env.FINANCE_SYNC_TOKEN].filter(Boolean) as string[]
  if (accepted.length > 0) {
    const auth = req.headers.get('authorization') ?? ''
    if (!accepted.some((s) => auth === `Bearer ${s}`)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    }
  }
  // Guarded diagnostic: confirms which DB + how many Plaid items production actually sees.
  if (new URL(req.url).searchParams.get('diag') === '1') {
    const { getDb } = await import('@/platform/db')
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
  try {
    const balances = await refreshPlaidBalances('cron')
    const transactions = await ingestTransactions('cron')
    logger.info('cron:finance-sync', 'synced', { balances, transactions })
    return NextResponse.json({ ok: true, balances, transactions })
  } catch (err) {
    logger.error('cron:finance-sync', 'failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
