/**
 * In-app new-booking alert for the home screen.
 *
 * The phone push is a convenience that can fail (phone off, notifications declined, a push service
 * having a bad day). This banner is the part that cannot: it reads the same unacknowledged online
 * bookings the Appointments screen shows, straight from the database, every time Home is opened.
 * One booking links to that appointment; several link to the list, where "Mark seen" already lives.
 *
 * Shows nothing at all when there is nothing new, and never renders customer contact details.
 */
import Link from 'next/link'
import { employeeAuthorized } from '@/apps/auth/employee-guard'
import { getBookingConfig, listAppointments } from '@/apps/appointments/db'
import { formatDateLabel, formatTimeLabel } from '@/apps/appointments/policy'

export default async function NewBookingAlert() {
  // The home page itself is NOT behind the employee gate in proxy.ts (only the tool paths are), so
  // this banner has to gate itself — otherwise an unauthenticated visitor would learn that the shop
  // has new bookings, and when they are due.
  if (!(await employeeAuthorized())) return null

  let fresh: Awaited<ReturnType<typeof listAppointments>> = []
  try {
    const cfg = await getBookingConfig()
    fresh = await listAppointments({ view: 'new', tz: cfg.timezone, limit: 20 })
  } catch {
    // Home must open even if this read fails — the alert is additive, never a gate.
    return null
  }
  if (!fresh.length) return null

  const newest = fresh[fresh.length - 1]
  const one = fresh.length === 1
  const href = one ? `/appointments/${newest.id}` : '/appointments?view=today'

  return (
    <Link
      href={href}
      className="mb-5 flex min-h-11 items-center gap-3 rounded-xl border border-emerald-700 bg-emerald-950/40 px-4 py-3 transition-colors hover:border-emerald-500 hover:bg-emerald-950/60"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-emerald-100">
          {one ? 'New online booking' : `${fresh.length} new online bookings`}
        </span>
        <span className="mt-0.5 block break-words text-xs text-emerald-200/80">
          {one
            ? `Drop-off ${formatDateLabel(newest.localDate)} at ${formatTimeLabel(newest.localTime)} — tap to open it.`
            : `Latest drop-off ${formatDateLabel(newest.localDate)} at ${formatTimeLabel(newest.localTime)} — tap to review them.`}
        </span>
      </span>
      <svg className="shrink-0 text-emerald-400" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Link>
  )
}
