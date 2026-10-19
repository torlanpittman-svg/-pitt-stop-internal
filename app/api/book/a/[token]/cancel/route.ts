/** POST /api/book/a/[token]/cancel — PUBLIC, scoped to the one appointment the private link names. */
import { NextResponse, after } from 'next/server'
import { getAppointmentByToken, cancelAppointment, BookingError } from '@/apps/appointments/db'
import { dispatchDue } from '@/apps/appointments/notify'
import { publicSummary } from '@/apps/appointments/public'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const appt = await getAppointmentByToken(token)
  if (!appt) return NextResponse.json({ ok: false, error: 'Appointment not found.' }, { status: 404 })
  try {
    const updated = await cancelAppointment(appt.id, { actor: 'customer', by: 'customer' })
    after(() => dispatchDue({ appointmentId: appt.id }).catch((e) => console.error('[book] dispatch failed:', e)))
    return NextResponse.json({ ok: true, appointment: publicSummary(updated) })
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ ok: false, error: err.message }, { status: err.code === 'not_found' ? 404 : 409 })
    console.error('[book] cancel failed:', err)
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please call the shop.' }, { status: 500 })
  }
}
