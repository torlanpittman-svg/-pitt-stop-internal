/**
 * GET /api/cron/marketing-weekly-report
 * Computes the weekly executive marketing report (read-only aggregation of stored marketing data).
 * Sends nothing externally. Mirrors the drain-dealer-queue / finance-sync auth: when CRON_SECRET is
 * set the scheduled run must present it (Vercel Cron sends it); MARKETING_CRON_TOKEN authorizes a
 * manual run; otherwise it falls open so the schedule keeps working until hardened.
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
  const bearerOk = (!!secret && auth === `Bearer ${secret}`) || (!!token && auth === `Bearer ${token}`)
  if (secret) return bearerOk      // secret configured → require it
  return true                       // no secret set → fall open (parity with other crons)
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const report = await weeklyReport(new Date())
    logger.info('cron:marketing-weekly-report', 'computed', {
      spendCents: report.current.spendCents,
      attributedRevenueCents: report.current.attributedRevenueCents,
      leads: report.current.leads,
    })
    return NextResponse.json({ ok: true, report })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('cron:marketing-weekly-report', 'failed', { error: msg })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
