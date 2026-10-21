/**
 * PUBLIC private appointment link (/book/a/<opaque token>): view one appointment, add it to a calendar,
 * cancel online until the configured cutoff. Rescheduling is staff-assisted (call the shop).
 * Shows only the customer-safe summary; unknown tokens get a generic not-found.
 */
import type { Metadata } from 'next'
import { getAppointmentByToken, getBookingConfig } from '@/apps/appointments/db'
import { publicSummary, canCustomerCancel } from '@/apps/appointments/public'
import CancelButton from './CancelButton'
import { BookShell, telHref } from '../../BookShell'

export const metadata: Metadata = { title: 'Your Appointment — Pitt Stop Detail & Auto Sales', robots: { index: false, follow: false }, referrer: 'no-referrer' }
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS_COPY: Record<string, string> = {
  confirmed: 'Appointment Confirmed', arrived: 'Vehicle checked in', cancelled: 'Appointment cancelled', no_show: 'Missed appointment',
}

export default async function ManageAppointment({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const [appt, cfg] = await Promise.all([getAppointmentByToken(token), getBookingConfig()])
  if (!appt) {
    return (
      <BookShell phone={cfg.phone} address={cfg.address} heading="Your Appointment" hero={false}>
        <h1 className="text-2xl font-bold text-[var(--ps-navy)]">Appointment not found</h1>
        <p className="mt-2 text-[var(--ps-body)]">This link isn&apos;t valid. Please call <a className="font-medium text-[var(--ps-navy)] underline" href={telHref(cfg.phone)}>{cfg.phone}</a>.</p>
      </BookShell>
    )
  }
  const a = publicSummary(appt)
  const canCancel = canCustomerCancel(appt, cfg)
  return (
    <BookShell phone={cfg.phone} address={cfg.address} heading="Your Appointment">
      <h2 className="text-2xl font-bold text-[var(--ps-navy)]">{STATUS_COPY[a.status] ?? 'Your appointment'}</h2>
      {a.status === 'confirmed' && <p className="mt-2 text-[var(--ps-body)]">This is your drop-off time &mdash; when you bring the vehicle in, not when it will be finished.</p>}
      <dl className="mt-5 divide-y divide-[var(--ps-line)] rounded-2xl border border-[var(--ps-line)] bg-white">
        {[
          ['Drop-off', `${a.dateLabel} at ${a.timeLabel}`],
          ['Service', a.services],
          ['Vehicle', a.vehicle],
          ['Reference', a.reference],
          ['Location', cfg.address],
          ['Phone', cfg.phone],
        ].filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="flex gap-3 px-4 py-3">
            <dt className="w-[5.5rem] shrink-0 text-sm text-[var(--ps-body)]">{k}</dt>
            <dd className={`min-w-0 break-words ${k === 'Drop-off' ? 'font-semibold text-[var(--ps-navy)]' : 'text-[var(--ps-ink)]'} ${a.status === 'cancelled' && k === 'Drop-off' ? 'line-through opacity-70' : ''}`}>{v}</dd>
          </div>
        ))}
      </dl>
      {appt.status === 'confirmed' && (
        <>
          <p className="mt-5 text-[0.95rem] text-[var(--ps-ink)]">{cfg.instructions}</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <a href={`/api/book/a/${token}/ics`} className="ps-btn-secondary">Add to calendar</a>
            <a href={telHref(cfg.phone)} className="ps-btn-call">Call to change the time</a>
          </div>
          {canCancel
            ? <CancelButton token={token} />
            : <p className="mt-6 text-sm text-[var(--ps-body)]">It&apos;s too close to your drop-off time to cancel online. Please call {cfg.phone}.</p>}
        </>
      )}
      {appt.status === 'cancelled' && (
        <a href="/book" className="ps-btn-primary mt-6">Book a new time</a>
      )}
    </BookShell>
  )
}
