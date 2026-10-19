/**
 * Staff Appointments — Today / Upcoming / Past / Search, plus the persistent "New online bookings"
 * alert (works even when no email provider is configured). Employee-PIN gated in proxy.ts.
 */
import Link from 'next/link'
import NavHeader from '@/app/components/NavHeader'
import { PageContainer, PageHeader } from '@/app/components/ui/PageHeader'
import { Badge } from '@/app/components/ui/Badge'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { getBookingConfig, listAppointments, type Appointment } from '@/apps/appointments/db'
import { bookingReadiness, formatDateLabel, formatTimeLabel, localParts, publicBookingOpen } from '@/apps/appointments/policy'
import AcknowledgeButton from './AcknowledgeButton'
import { STATUS_TONE, STATUS_LABEL, SOURCE_LABEL } from './labels'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const VIEWS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['past', 'Past'], ['search', 'Search']] as const
type View = (typeof VIEWS)[number][0]

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<{ view?: string; q?: string }> }) {
  const sp = await searchParams
  const view: View = (VIEWS.map((v) => v[0]) as string[]).includes(sp.view ?? '') ? sp.view as View : 'today'
  const [cfg, mgr] = await Promise.all([getBookingConfig(), authorizedManager()])
  const [rows, fresh] = await Promise.all([
    listAppointments({ view, q: sp.q, tz: cfg.timezone }),
    listAppointments({ view: 'new', tz: cfg.timezone }),
  ])
  const today = localParts(new Date(), cfg.timezone).date
  const readiness = bookingReadiness(cfg)

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/', label: 'Home' }} title="Appointments" />
      <PageContainer className="py-6">
        <PageHeader
          kicker="Drop-offs"
          title="Appointments"
          subtitle={publicBookingOpen(cfg) ? 'Online booking is ON.' : `Online booking is OFF${readiness.ready ? '' : ` — needs: ${readiness.missing.join(', ')}`}.`}
          actions={<>
            <Link href="/appointments/new" className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-gray-950">+ New appointment</Link>
            {mgr && <Link href="/appointments/settings" className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-200">Settings</Link>}
          </>}
        />

        {fresh.length > 0 && (
          <div className="mt-5 rounded-xl border border-emerald-800 bg-emerald-950/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-emerald-200">{fresh.length} new online booking{fresh.length === 1 ? '' : 's'}</p>
              <AcknowledgeButton ids={fresh.map((a) => a.id)} />
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {fresh.slice(0, 8).map((a) => (
                <li key={a.id}><Link href={`/appointments/${a.id}`} className="text-emerald-100 underline-offset-2 hover:underline">
                  {formatDateLabel(a.localDate)} {formatTimeLabel(a.localTime)} — {a.firstName} {a.lastName} · {a.serviceLabels}
                </Link></li>
              ))}
            </ul>
          </div>
        )}

        <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-gray-900" aria-label="Appointment views">
          {VIEWS.map(([k, label]) => (
            <Link key={k} href={`/appointments?view=${k}`} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${view === k ? 'border-emerald-400 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>{label}</Link>
          ))}
        </nav>

        {view === 'search' && (
          <form className="mt-4" action="/appointments">
            <input type="hidden" name="view" value="search" />
            <input name="q" defaultValue={sp.q ?? ''} placeholder="Name, phone, email, reference, vehicle…" autoFocus
              className="h-12 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 text-base text-white placeholder-gray-600 focus:border-emerald-500 focus:outline-none" />
          </form>
        )}

        <AppointmentList rows={rows} showDate={view !== 'today'} today={today}
          empty={view === 'today' ? 'No drop-offs today.' : view === 'upcoming' ? 'No upcoming appointments.' : view === 'search' ? (sp.q ? 'No matches.' : 'Type at least 2 characters.') : 'No past appointments.'} />
      </PageContainer>
    </div>
  )
}

function AppointmentList({ rows, showDate, empty, today }: { rows: Appointment[]; showDate: boolean; empty: string; today: string }) {
  if (!rows.length) return <p className="mt-8 text-sm text-gray-400">{empty}</p>
  const headers = rows.map((a, i) => (showDate && (i === 0 || rows[i - 1].localDate !== a.localDate) ? a.localDate : null))
  return (
    <ul className="mt-4 space-y-2">
      {rows.map((a, i) => {
        const header = headers[i]
        return (
          <li key={a.id}>
            {header && <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-gray-500">{header === today ? 'Today' : formatDateLabel(header)}</p>}
            <Link href={`/appointments/${a.id}`} className="flex items-start gap-3 rounded-xl border border-gray-800 bg-gray-900 p-3.5 hover:border-gray-600">
              <span className="w-16 shrink-0 pt-0.5 font-semibold tabular-nums">{formatTimeLabel(a.localTime)}</span>
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">{a.firstName} {a.lastName}</span>
                <span className="block break-words text-sm text-gray-400">{[a.vehicleYear, a.vehicleMake, a.vehicleModel].filter(Boolean).join(' ') || 'Vehicle not given'} · {a.serviceLabels}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
                <span className="text-[11px] text-gray-500">{SOURCE_LABEL[a.source] ?? a.source}</span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
