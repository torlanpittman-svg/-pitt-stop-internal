/**
 * PUBLIC resume link for an unfinished booking (/book/r/<opaque token>), sent only in the one follow-up email
 * a customer asked for. Pre-fills their saved answers and opens on "Time & contact" with LIVE availability —
 * the time they looked at before is not held and is offered again only if it is still open.
 * The token carries no customer data; the page sets no-referrer and is not indexed.
 */
import type { Metadata } from 'next'
import { getBookingConfig } from '@/apps/appointments/db'
import { getDraftByToken, recordResume } from '@/apps/appointments/drafts'
import { isOnlineType } from '@/apps/appointments/vehicles'
import BookingFlow from '../../BookingFlow'
import { BookShell, telHref } from '../../BookShell'
import { flowProps } from '../../flow-props'

export const metadata: Metadata = {
  title: 'Finish Booking — Pitt Stop Detail & Auto Sales',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function ResumeBooking({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const [draft, cfg] = await Promise.all([getDraftByToken(token), getBookingConfig()])
  const props = await flowProps(cfg)

  if (!draft || draft.status !== 'open') {
    return (
      <BookShell phone={cfg.phone} address={cfg.address} heading="Schedule a Drop-Off">
        <h2 className="text-2xl font-bold text-[var(--ps-navy)]">{draft?.status === 'booked' ? 'This booking is already complete' : 'This link has expired'}</h2>
        <p className="mt-2 text-[var(--ps-body)]">
          {draft?.status === 'booked'
            ? 'You already booked this drop-off. Use the link on your confirmation to view or cancel it, or call us.'
            : 'You can start a new booking. It only takes a minute.'}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/book" className="ps-btn-primary">Start a booking</a>
          <a href={telHref(cfg.phone)} className="ps-btn-secondary">Call {cfg.phone}</a>
        </div>
      </BookShell>
    )
  }

  await recordResume(draft.id)
  const services = (draft.serviceKeys ?? []).filter((k) => props.services.some((s) => s.key === k))
  const type = isOnlineType(draft.vehicleType) ? draft.vehicleType : ''
  return (
    <BookingFlow {...props} preselect={[]} attribution={draft.attribution ?? {}}
      resume={{
        draftKey: draft.clientKey, services,
        vehicle: { type, year: draft.vehicleYear ?? '', make: type === 'trailer' ? '' : draft.vehicleMake ?? '', model: draft.vehicleModel ?? '' },
        contact: { firstName: draft.firstName ?? '', lastName: draft.lastName ?? '', phone: draft.phone ?? '', email: draft.email ?? '', notes: draft.notes ?? '' },
        followUp: draft.followUpConsent, preferredDate: draft.preferredDate, preferredTime: draft.preferredTime,
      }}
      resumeNote="Welcome back — your answers are saved. Pick a drop-off time from what's open now; times aren't held until you book." />
  )
}
