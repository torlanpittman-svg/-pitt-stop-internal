/**
 * POST /api/dealer-checkin/retry-queue
 * Drains queued check-ins (QB was unavailable at capture time) and completes
 * their invoice writes. Safe to call repeatedly; intended for a cron/heartbeat.
 * GET returns the current queue depth without doing any work.
 */
import { NextResponse } from 'next/server'
import { retryQueuedCheckIns } from '@/apps/dealer-checkin/service'
import { listQueuedScans } from '@/apps/dealer-checkin/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const queued = await listQueuedScans()
  return NextResponse.json({ queueDepth: queued.length })
}

export async function POST() {
  try {
    const result = await retryQueuedCheckIns()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
