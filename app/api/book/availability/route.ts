/**
 * GET /api/book/availability?services=complete_detail,odor&from=YYYY-MM-DD — PUBLIC (customer booking).
 * Returns only whether each drop-off time can be booked. Never returns names, counts or other bookings.
 */
import { NextResponse } from 'next/server'
import { getAvailability, getBookingConfig } from '@/apps/appointments/db'
import { publicBookingOpen } from '@/apps/appointments/policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const cfg = await getBookingConfig()
  if (!publicBookingOpen(cfg)) return NextResponse.json({ ok: true, open: false, days: [] })
  const serviceKeys = (url.searchParams.get('services') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12)
  const { days } = await getAvailability({ cfg, serviceKeys, fromDate: url.searchParams.get('from') ?? undefined, days: 14, publicOnly: true })
  return NextResponse.json({
    ok: true, open: true,
    days: days.map((d) => ({ date: d.date, closed: d.closed || !d.slots.some((s) => s.available), closedReason: d.closed ? d.closedReason : undefined,
      slots: d.slots.filter((s) => s.reason !== 'past').map((s) => ({ time: s.time, available: s.available })) })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
