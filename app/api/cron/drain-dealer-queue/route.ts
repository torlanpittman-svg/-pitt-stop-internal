/**
 * GET /api/cron/drain-dealer-queue
 * Scheduled drain of queued dealer check-ins (Vercel Cron target). Completes the
 * QuickBooks invoice writes that were queued while QB was unavailable.
 *
 * Auth: when CRON_SECRET is set, requires `Authorization: Bearer <CRON_SECRET>`
 * (Vercel Cron sends this automatically). When unset (local dev), runs open.
 * Draining is idempotent and non-destructive, so this is safe to call repeatedly.
 *
 * Note: Vercel Hobby allows one cron run per day (see vercel.json). Sub-daily
 * auto-drain needs a Pro plan (owner/billing decision). The admin "Drain queue"
 * button and the opportunistic drain remain available for immediate processing.
 */
import { NextResponse } from 'next/server'
import { retryQueuedCheckIns, cleanupDealerImages } from '@/apps/dealer-checkin/service'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    }
  }
  try {
    const result = await retryQueuedCheckIns()
    const cleanup = await cleanupDealerImages()
    logger.info('cron:drain-dealer-queue', 'drained', { ...result, cleanup })
    return NextResponse.json({ ok: true, ...result, cleanup })
  } catch (err) {
    logger.error('cron:drain-dealer-queue', 'failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
