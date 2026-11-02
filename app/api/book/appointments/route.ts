/**
 * POST /api/book/appointments — PUBLIC: book a confirmed drop-off. Server-side validation, capacity
 * re-checked atomically, idempotent per submission key, per-connection rate limit, honeypot field.
 * Responds with the confirmation summary + the customer's private appointment link token.
 */
import { NextResponse, after } from 'next/server'
import { createAppointment, BookingError, hashIp, type BookingInput } from '@/apps/appointments/db'
import { dispatchDue, transactionalEmailProvider, AllowlistEmailProvider } from '@/apps/appointments/notify'
import { getBookingConfig } from '@/apps/appointments/db'
import { publicSummary } from '@/apps/appointments/public'
import { dispatchStaffAlerts, recordNewBookingAlert } from '@/apps/staff-alerts/db'
import { getMarketingConfig } from '@/apps/settings/db'
import { a2pProfile, smsDisclosureText, SMS_OPT_IN_VERSION } from '@/apps/marketing/compliance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// The post-response work (customer confirmation email + the staff push) talks to third parties.
// Without headroom the invocation can be torn down mid-send, which burns a delivery attempt.
export const maxDuration = 60

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
      vehicleType: body.vehicleType, vehicleYear: body.vehicleYear, vehicleMake: body.vehicleMake, vehicleModel: body.vehicleModel,
      vehicleColor: body.vehicleColor, vehiclePlate: body.vehiclePlate, vehicleVin: body.vehicleVin,
      notes: body.notes, smsMarketingOptIn: body.smsMarketingOptIn === true, attribution: body.attribution ?? {},
      draftKey: typeof body.draftKey === 'string' && body.draftKey ? body.draftKey : undefined,
    }, {
      mode: 'public', source: 'website_booking', actor: null, ipHash: hashIp(ip),
      smsConsent: { text: smsDisclosureText(p), version: SMS_OPT_IN_VERSION, ip, userAgent: req.headers.get('user-agent') },
    })
    if (!replayed) after(() => dispatchDue({ appointmentId: appointment.id }).catch((e) => console.error('[book] dispatch failed:', e)))
    // Staff alert. The booking is already committed, so neither of these can undo it:
    //   1. record the alert now, while we are certainly still running (an `after` callback can be
    //      dropped if the invocation is torn down). A failure is swallowed — the next dispatch
    //      recreates the alert from the appointment, and the in-app banner never needed it.
    //   2. deliver only THAT alert after the response, so one slow phone cannot eat the whole
    //      invocation and so the customer never waits on a push service.
    if (!replayed) {
      const alertId = await recordNewBookingAlert(appointment.id).catch((e) => {
        console.error('[book] staff alert not recorded (booking kept; cron will recreate it):', e)
        return null
      })
      if (alertId) after(() => dispatchStaffAlerts({ alertId }).catch((e) => console.error('[book] staff alert dispatch failed:', e)))
    }
    // 'queued' only when a live provider will actually attempt this address — the page then says "sending",
    // never "sent". Otherwise the page itself is the confirmation.
    const provider = transactionalEmailProvider()
    const cfg = await getBookingConfig()
    const attempts = !!appointment.email && cfg.confirmationEnabled && provider.live &&
      (!(provider instanceof AllowlistEmailProvider) || provider.allows(appointment.email))
    return NextResponse.json({ ok: true, token, appointment: publicSummary(appointment), confirmationEmail: attempts ? 'queued' : 'off' })
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status: STATUS[err.code] })
    console.error('[book] booking failed:', err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please try again or call the shop.' }, { status: 500 })
  }
}
