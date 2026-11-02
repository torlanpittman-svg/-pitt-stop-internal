/**
 * GET /api/cron/appointment-notifications — daily (vercel.json, ~5 PM Central): sends due appointment
 * reminders (24 h before a next-morning drop-off are all due by then) and retries failed notices.
 * FAIL-CLOSED auth: bearer CRON_SECRET (Vercel Cron) required; no secret configured → denied.
 * With no email provider configured, notices are recorded as not_configured — nothing is sent.
 * Also runs the unfinished-booking follow-up and retention jobs — each a no-op unless a manager has turned it
 * on in Booking settings (both OFF by default, pending owner approval).
 */
import { NextResponse } from 'next/server'
import { dispatchDue } from '@/apps/appointments/notify'
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
    const tally = await dispatchDue({ limit: 200 })
    // Daily backstop for the hourly /api/cron/booking-follow-ups. Retention first, so expired drafts are never emailed.
    const retention = await purgeExpiredDrafts()
    const followUps = await dispatchDraftFollowUps({ limit: 100 })
    // The GUARANTEED retry pass for staff new-booking push alerts (the hourly GitHub schedule is
    // optional): fans out and retries any new-booking push that has not reached a manager's phone,
    // and ages out anything too old to still be useful.
    // A push problem must never turn a successful run of the customer-facing jobs above into a
    // failure (and a failed retry stays queued for the next run either way).
    const staffAlerts = await dispatchStaffAlerts({ limit: 50 }).catch((err) => {
      logger.error('cron:appointment-notifications', 'staff_alerts_failed', { error: err instanceof Error ? err.message : String(err) })
      return { error: 'dispatch failed' }
    })
    // Counts only — never customer details.
    logger.info('cron:appointment-notifications', 'dispatched', { ...tally, followUps, retention, staffAlerts })
    return NextResponse.json({ ok: true, ...tally, followUps, retention, staffAlerts })
  } catch (err) {
    logger.error('cron:appointment-notifications', 'failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: 'dispatch failed' }, { status: 500 })
  }
}
