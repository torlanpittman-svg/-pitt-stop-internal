/**
 * PUBLIC private appointment link (/book/a/<opaque token>): view one appointment, add it to a calendar,
 * cancel online until the configured cutoff. Rescheduling is staff-assisted (call the shop).
 * Shows only the customer-safe summary; unknown tokens get a generic not-found.
 */
import type { Metadata } from 'next'
import { getAppointmentByToken, getBookingConfig } from '@/apps/appointments/db'
import { publicSummary, canCustomerCancel } from '@/apps/appointments/public'
import CancelButton from './CancelButton'

export const metadata: Metadata = { title: 'Your Appointment — Pitt Stop Detail & Auto Sales', robots: { index: false, follow: false } }
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS_COPY: Record<string, string> = {
  confirmed: 'Appointment Confirmed', arrived: 'Vehicle checked in', cancelled: 'Appointment cancelled', no_show: 'Missed appointment',
}

export default async function ManageAppointment({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const [appt, cfg] = await Promise.all([getAppointmentByToken(token), getBookingConfig()])
  const tel = cfg.phone.replace(/[^\d+]/g, '')
  if (!appt) {
    return (
      <main className="min-h-screen bg-gray-950 px-4 py-12 text-white">
        <div className="mx-auto max-w-xl">
          <h1 className="text-2xl font-bold">Appointment not found</h1>
          <p className="mt-3 text-gray-300">This link isn&apos;t valid. Please call <a className="text-emerald-400" href={`tel:${tel}`}>{cfg.phone}</a>.</p>
        </div>
      </main>
    )
  }
  const a = publicSummary(appt)
  const canCancel = canCustomerCancel(appt, cfg)
  return (
    <main className="min-h-screen bg-gray-950 px-4 py-10 text-white">
      <div className="mx-auto max-w-xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400">Pitt Stop Detail &amp; Auto Sales</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{STATUS_COPY[a.status] ?? 'Your appointment'}</h1>
        <dl className="mt-6 divide-y divide-gray-800 rounded-2xl border border-gray-800 bg-gray-900">
          {[
            ['Drop-off', `${a.dateLabel} at ${a.timeLabel}`],
            ['Service', a.services],
            ['Vehicle', a.vehicle],
            ['Reference', a.reference],
            ['Location', cfg.address],
            ['Phone', cfg.phone],
          ].filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="flex gap-3 px-4 py-3">
              <dt className="w-20 shrink-0 text-sm text-gray-500">{k}</dt>
              <dd className={`min-w-0 break-words ${k === 'Drop-off' ? 'font-semibold' : 'text-gray-200'} ${a.status === 'cancelled' && k === 'Drop-off' ? 'line-through text-gray-400' : ''}`}>{v}</dd>
            </div>
          ))}
        </dl>
        {appt.status === 'confirmed' && (
          <>
            <p className="mt-5 text-sm leading-relaxed text-gray-300">{cfg.instructions}</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <a href={`/api/book/a/${token}/ics`} className="flex min-h-12 items-center justify-center rounded-xl border border-gray-700 font-medium hover:border-gray-500">Add to calendar</a>
              <a href={`tel:${tel}`} className="flex min-h-12 items-center justify-center rounded-xl border border-gray-700 font-medium hover:border-gray-500">Call to change the time</a>
            </div>
            {canCancel
              ? <CancelButton token={token} />
              : <p className="mt-6 text-sm text-gray-400">It&apos;s too close to your drop-off time to cancel online. Please call {cfg.phone}.</p>}
          </>
        )}
        {appt.status === 'cancelled' && (
          <a href="/book" className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-emerald-500 px-5 font-semibold text-gray-950">Book a new time</a>
        )}
      </div>
    </main>
  )
}
