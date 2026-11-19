/**
 * GET /api/cron/recovery-follow-ups/<slot> — Lead Recovery follow-ups ONLY (never confirmations or reminders).
 *
 * WHY THIS EXISTS: the "hourly" GitHub Actions schedule that calls /api/cron/booking-follow-ups is active, but
 * GitHub runs it only a few times a day (measured 2026-11-19: about every 6–10 hours). Vercel Hobby allows up to 100
 * cron jobs per project, each at most once a day, firing some time within its hour. So vercel.json lists one daily
 * job per hour of the send window, each with its own <slot> path — together a dependable roughly-hourly tick with
 * no new service. <slot> is only a label that keeps the paths distinct.
 *
 * Safe to call any number of times, concurrently or not: every email is claimed with a conditional update, passes
 * the send-time gate, and exists once per cancellation (unique dedupe key). A run interrupted by a crash, timeout or
 * deploy is repaired by the next one (recoverInterruptedEmails) without resending. A no-op while recovery emails
 * are off in Booking settings.
 *
 * FAIL-CLOSED auth: bearer CRON_SECRET (Vercel Cron) required; no secret configured → denied.
 */
import { NextResponse } from 'next/server'
import { dispatchDue } from '@/apps/appointments/notify'
import { reconcileRecoveries } from '@/apps/appointments/recovery'
import { checkRecoveryStream } from '@/apps/appointments/postmark-sync'
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
    const reconciled = await reconcileRecoveries()
    const tally = await dispatchDue({ only: 'recovery', limit: 50 })
    // Read-only health check of the Postmark stream recovery emails use (ID + type only; sends nothing).
    const stream = await checkRecoveryStream()
    // Counts only — never customer details.
    logger.info('cron:recovery-follow-ups', 'dispatched', { ...reconciled, ...tally, stream })
    return NextResponse.json({ ok: true, ...reconciled, ...tally })
  } catch (err) {
    logger.error('cron:recovery-follow-ups', 'failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: 'dispatch failed' }, { status: 500 })
  }
}
