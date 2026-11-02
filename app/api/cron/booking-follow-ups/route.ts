/**
 * GET /api/cron/booking-follow-ups — the unfinished-booking jobs only: retention erase (first, so an expired
 * draft is never emailed), interrupted-send recovery and the one follow-up email. Each is a no-op until a
 * manager turns it on in Booking settings.
 *
 * WHY A SEPARATE ENDPOINT: the team is on Vercel Hobby, where a Vercel cron runs at most once a day — a 24 h
 * follow-up could then wait up to ~48 h. This endpoint is called HOURLY by the GitHub Actions schedule in
 * .github/workflows/booking-follow-ups.yml (free tier) and also, as a backstop, by the existing daily
 * /api/cron/appointment-notifications. Safe to call any number of times, concurrently or not: claims, the final
 * per-email check and the never-early rule make extra calls harmless.
 *
 * FAIL-CLOSED auth: bearer CRON_SECRET required; no secret configured → denied.
 */
import { NextResponse } from 'next/server'
import { dispatchDraftFollowUps, purgeExpiredDrafts } from '@/apps/appointments/drafts'
import { dispatchStaffAlerts } from '@/apps/staff-alerts/db'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  try {
    const retention = await purgeExpiredDrafts()
    const followUps = await dispatchDraftFollowUps({ limit: 100 })
    // Retry pass for staff new-booking push alerts. NOTE: this endpoint is only called hourly if the
    // owner has enabled .github/workflows/booking-follow-ups.yml (two repository settings); until
    // then the daily /api/cron/appointment-notifications is the only retry. See docs/BOOKING_ALERTS.md §6.
    // A push problem must never turn a successful run of the customer-facing jobs above into a
    // failure (and a failed retry stays queued for the next run either way).
    const staffAlerts = await dispatchStaffAlerts({ limit: 50 }).catch((err) => {
      logger.error('cron:booking-follow-ups', 'staff_alerts_failed', { error: err instanceof Error ? err.message : String(err) })
      return { error: 'dispatch failed' }
    })
    // Counts only — never customer details.
    logger.info('cron:booking-follow-ups', 'dispatched', { followUps, retention, staffAlerts })
    return NextResponse.json({ ok: true, followUps, retention, staffAlerts })
  } catch (err) {
    logger.error('cron:booking-follow-ups', 'failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: 'dispatch failed' }, { status: 500 })
  }
}
