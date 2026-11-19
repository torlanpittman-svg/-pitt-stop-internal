/**
 * PUBLIC rebooking link for a cancelled appointment (/book/c/<opaque token>), sent only in recovery emails.
 * Opens the normal booking flow on "Time & contact" with the customer's earlier services, vehicle and contact
 * details filled in and LIVE availability — nothing is held. Booking from here credits the new appointment to
 * the cancelled one. The token carries no customer data; the page sets no-referrer and is not indexed, and it
 * stops pre-filling once the link window (booking_config.recoveryLinkDays) has passed or the customer has
 * rebooked. Opening the link changes nothing.
 */
import type { Metadata } from 'next'
import { randomUUID } from 'node:crypto'
import { getAppointment, getBookingConfig } from '@/apps/appointments/db'
import { getRecoveryByToken, recoveryWindowOpen } from '@/apps/appointments/recovery'
import { isOnlineType } from '@/apps/appointments/vehicles'
import { normalizeBookingReferral } from '@/apps/appointments/referral'
import BookingFlow from '../../BookingFlow'
import { BookShell, telHref } from '../../BookShell'
import { flowProps } from '../../flow-props'

export const metadata: Metadata = {
  title: 'Reschedule — Pitt Stop Detail & Auto Sales',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function RecoveryBooking({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const [rec, cfg] = await Promise.all([getRecoveryByToken(token), getBookingConfig()])
  const props = await flowProps(cfg)
  const appt = rec ? await getAppointment(rec.appointmentId) : null
  const expired = !rec || !appt || !recoveryWindowOpen(rec, cfg)

  if (expired || rec.status === 'rebooked') {
    const rebooked = !expired && rec.status === 'rebooked'
    return (
      <BookShell phone={cfg.phone} address={cfg.address} heading="Schedule a Drop-Off">
        <h2 className="text-2xl font-bold text-[var(--ps-navy)]">{rebooked ? 'You’re already rebooked' : 'This link has expired'}</h2>
        <p className="mt-2 text-[var(--ps-body)]">
          {rebooked ? 'Use the link in your confirmation email to view or cancel your appointment, or call us.' : 'You can start a new booking. It only takes a minute.'}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/book" className="ps-btn-primary">Start a booking</a>
          <a href={telHref(cfg.phone)} className="ps-btn-secondary">Call {cfg.phone}</a>
        </div>
      </BookShell>
    )
  }

  const earlier = normalizeBookingReferral({ source: appt.referralSource, detail: appt.referralDetail })
  const services = (appt.serviceKeys ?? []).filter((k) => props.services.some((s) => s.key === k))
  const type = isOnlineType(appt.vehicleType) ? appt.vehicleType : ''
  return (
    <BookingFlow {...props} preselect={[]} attribution={appt.attribution ?? {}} recoveryToken={token}
      resume={{
        // A fresh unfinished-booking key: this is a new booking attempt, not the cancelled one.
        draftKey: randomUUID(), services,
        vehicle: { type, year: appt.vehicleYear ?? '', make: type === 'trailer' ? '' : appt.vehicleMake ?? '', model: appt.vehicleModel ?? '' },
        contact: { firstName: appt.firstName, lastName: appt.lastName, phone: appt.phone, email: appt.email ?? '', notes: '' },
        followUp: false, preferredDate: null, preferredTime: null,
        // Their own earlier answer, so a returning customer is not asked "how did you hear about us?" twice.
        referral: earlier.source ? { source: earlier.source, detail: earlier.detail } : undefined,
      }}
      resumeNote="Welcome back — your details are filled in. Pick a new drop-off time from what’s open now." />
  )
}
