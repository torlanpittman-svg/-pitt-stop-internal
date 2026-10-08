/**
 * GET /api/cron/marketing-weekly-report
 * Computes the weekly executive marketing report (read-only aggregation of stored marketing data).
 * Sends nothing externally. FAIL-CLOSED auth: a bearer CRON_SECRET (Vercel Cron) or
 * MARKETING_CRON_TOKEN (manual run) is REQUIRED. If neither secret is configured the endpoint denies
 * all requests — it never falls open to publicly expose report data.
 */
import { NextResponse } from 'next/server'
import { weeklyReport } from '@/apps/marketing/report'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  const token = process.env.MARKETING_CRON_TOKEN
  const auth = req.headers.get('authorization') ?? ''
  if (!secret && !token) return false  // fail-closed: no secret configured → deny, never expose data
  return (!!secret && auth === `Bearer ${secret}`) || (!!token && auth === `Bearer ${token}`)
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const report = await weeklyReport(new Date())
    logger.info('cron:marketing-weekly-report', 'computed', {
      spendCents: report.current.spendCents,
      invoicedRevenueCents: report.current.invoicedRevenueCents,
      completedJobs: report.current.completedJobs,
      leads: report.current.leads,
    })
    return NextResponse.json({ ok: true, report })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('cron:marketing-weekly-report', 'failed', { error: msg })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
