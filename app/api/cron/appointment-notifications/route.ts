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
    // Counts only — never customer details.
    logger.info('cron:appointment-notifications', 'dispatched', { ...tally, followUps, retention })
    return NextResponse.json({ ok: true, ...tally, followUps, retention })
  } catch (err) {
    logger.error('cron:appointment-notifications', 'failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: 'dispatch failed' }, { status: 500 })
  }
}
