/**
 * GET /api/dealer-checkin/metrics
 * Operational metrics for the dealer check-in workflow (production scans).
 */
import { NextResponse } from 'next/server'
import { getCheckInMetrics } from '@/apps/dealer-checkin/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const metrics = await getCheckInMetrics()
    return NextResponse.json({ ok: true, metrics })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
