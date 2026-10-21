/**
 * POST /api/book/drafts — PUBLIC: save the unfinished booking when the customer submits the completed contact
 * step ("Continue to review"). Never called while typing. Never reserves a time. Same validation as booking
 * (contact, services, vehicle from the lists), honeypot, per-connection rate limit. Returns no token or
 * customer data — the resume link is only ever emailed (and only with permission).
 */
import { NextResponse } from 'next/server'
import { BookingError, hashIp } from '@/apps/appointments/db'
import { saveDraft, type DraftInput } from '@/apps/appointments/drafts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS: Record<BookingError['code'], number> = { invalid: 400, closed: 409, full: 409, rate_limited: 429, not_found: 404, conflict: 409, too_late: 409 }

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as (DraftInput & { website?: string }) | null
  if (!body || typeof body !== 'object') return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  if (typeof body.website === 'string' && body.website.trim()) return NextResponse.json({ ok: false, error: 'Unable to continue online. Please call the shop.' }, { status: 400 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  try {
    await saveDraft({
      draftKey: body.draftKey, serviceKeys: Array.isArray(body.serviceKeys) ? body.serviceKeys : [],
      vehicleType: body.vehicleType, vehicleYear: body.vehicleYear, vehicleMake: body.vehicleMake, vehicleModel: body.vehicleModel,
      firstName: body.firstName, lastName: body.lastName, phone: body.phone, email: body.email,
      preferredDate: body.preferredDate, preferredTime: body.preferredTime, notes: body.notes,
      followUpConsent: body.followUpConsent === true, attribution: body.attribution ?? {},
    }, { ipHash: hashIp(ip) })
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status: STATUS[err.code] })
    // Log the failure without customer details.
    console.error('[book] draft save failed:', err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please try again or call the shop.' }, { status: 500 })
  }
}
