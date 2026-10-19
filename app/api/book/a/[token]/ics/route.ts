/** GET /api/book/a/[token]/ics — PUBLIC: "Add to calendar" file for the one appointment the link names. */
import { getAppointmentByToken, getBookingConfig } from '@/apps/appointments/db'
import { appointmentIcs } from '@/apps/appointments/public'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const appt = await getAppointmentByToken(token)
  if (!appt || appt.status === 'cancelled') return new Response('Not found', { status: 404 })
  return new Response(appointmentIcs(appt, await getBookingConfig()), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="pitt-stop-${appt.reference}.ics"`, 'Cache-Control': 'no-store' },
  })
}
