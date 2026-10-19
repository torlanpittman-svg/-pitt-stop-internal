/**
 * POST /api/book/appointments — PUBLIC: book a confirmed drop-off. Server-side validation, capacity
 * re-checked atomically, idempotent per submission key, per-connection rate limit, honeypot field.
 * Responds with the confirmation summary + the customer's private appointment link token.
 */
import { NextResponse, after } from 'next/server'
import { createAppointment, BookingError, hashIp, type BookingInput } from '@/apps/appointments/db'
import { dispatchDue } from '@/apps/appointments/notify'
import { publicSummary } from '@/apps/appointments/public'
import { getMarketingConfig } from '@/apps/settings/db'
import { a2pProfile, smsDisclosureText, SMS_OPT_IN_VERSION } from '@/apps/marketing/compliance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS: Record<BookingError['code'], number> = { invalid: 400, closed: 409, full: 409, rate_limited: 429, not_found: 404, conflict: 409, too_late: 409 }

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as (BookingInput & { website?: string }) | null
  if (!body || typeof body !== 'object') return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  // Honeypot: real customers never see or fill this field.
  if (typeof body.website === 'string' && body.website.trim()) return NextResponse.json({ ok: false, error: 'Unable to book online. Please call the shop.' }, { status: 400 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  try {
    const p = a2pProfile(await getMarketingConfig())
    const { appointment, token, replayed } = await createAppointment({
      idempotencyKey: body.idempotencyKey, date: body.date, time: body.time, serviceKeys: Array.isArray(body.serviceKeys) ? body.serviceKeys : [],
      firstName: body.firstName, lastName: body.lastName, phone: body.phone, email: body.email,
      vehicleYear: body.vehicleYear, vehicleMake: body.vehicleMake, vehicleModel: body.vehicleModel,
      vehicleColor: body.vehicleColor, vehiclePlate: body.vehiclePlate, vehicleVin: body.vehicleVin,
      notes: body.notes, smsMarketingOptIn: body.smsMarketingOptIn === true, attribution: body.attribution ?? {},
    }, {
      mode: 'public', source: 'website_booking', actor: null, ipHash: hashIp(ip),
      smsConsent: { text: smsDisclosureText(p), version: SMS_OPT_IN_VERSION, ip, userAgent: req.headers.get('user-agent') },
    })
    if (!replayed) after(() => dispatchDue({ appointmentId: appointment.id }).catch((e) => console.error('[book] dispatch failed:', e)))
    return NextResponse.json({ ok: true, token, appointment: publicSummary(appointment) })
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status: STATUS[err.code] })
    console.error('[book] booking failed:', err)
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please try again or call the shop.' }, { status: 500 })
  }
}
