/**
 * Staff: unfinished online bookings ("booking leads") — separate from confirmed appointments. A lead is a
 * customer who submitted the contact step on /book but did not confirm. It holds no time.
 * Managers/admins only, FAIL-CLOSED (authorizedManagerStrict): contact details of people who have not booked
 * are never shown to a synthetic dev identity or a non-manager. Employee-PIN gated in proxy.ts as well.
 */
import Link from 'next/link'
import { redirect } from 'next/navigation'
import NavHeader from '@/app/components/NavHeader'
import { PageContainer, PageHeader } from '@/app/components/ui/PageHeader'
import { Badge, type BadgeTone } from '@/app/components/ui/Badge'
import { authorizedManagerStrict } from '@/apps/auth/employee-guard'
import { getBookingConfig } from '@/apps/appointments/db'
import { formatTimeLabel } from '@/apps/appointments/policy'
import { shortDate } from '@/app/lib/format'
import { listDrafts, type BookingDraft } from '@/apps/appointments/drafts'
import { transactionalEmailProvider } from '@/apps/appointments/notify'
import { LeadStatusButtons, RequeueFollowUp } from './LeadControls'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const VIEWS = [['open', 'Not booked'], ['booked', 'Booked later'], ['all', 'All']] as const
type View = (typeof VIEWS)[number][0]

const FOLLOW_UP: Record<string, [string, BadgeTone]> = {
  not_permitted: ['No permission', 'neutral'], pending: ['Waiting to send', 'info'], sending: ['Sending', 'info'],
  sent: ['Sent', 'positive'], not_configured: ['Not sent — no email provider', 'warn'], failed: ['Failed', 'danger'],
  suppressed: ['Not sent', 'neutral'], uncertain: ['Delivery uncertain — may have been sent (never resent)', 'warn'],
}

const fmt = (d: Date | null) => d ? d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (!(await authorizedManagerStrict())) redirect('/appointments')
  const sp = await searchParams
  const view: View = (VIEWS.map((v) => v[0]) as string[]).includes(sp.view ?? '') ? sp.view as View : 'open'
  const [rows, cfg] = await Promise.all([listDrafts({ view }), getBookingConfig()])
  const email = transactionalEmailProvider()

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/appointments', label: 'Appointments' }} title="Unfinished bookings" />
      <PageContainer className="py-6">
        <PageHeader kicker="Online booking" title="Unfinished bookings"
          subtitle="People who entered their details on the booking page but did not confirm. These are not appointments and hold no time." />
        <p className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm text-gray-300">
          Follow-up email: {cfg.draftFollowUpEnabled
            ? <span className="text-emerald-300">ON — one email {cfg.draftFollowUpDelayHours} h after last activity, only to customers who ticked the box</span>
            : <span className="text-amber-300">OFF (turn on in Booking settings)</span>}
          {' · '}Provider: {email.live ? email.name : <span className="text-amber-300">none set up</span>}
          {' · '}Retention: {cfg.draftRetentionEnabled ? `${cfg.draftRetentionDays} days` : <span className="text-amber-300">not enforced yet</span>}
        </p>

        <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-gray-900" aria-label="Lead views">
          {VIEWS.map(([k, label]) => (
            <Link key={k} href={`/appointments/leads?view=${k}`} aria-current={view === k ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${view === k ? 'border-emerald-400 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>{label}</Link>
          ))}
        </nav>

        {!rows.length
          ? <p className="mt-8 text-sm text-gray-400">{view === 'open' ? 'No unfinished bookings.' : 'Nothing here yet.'}</p>
          : <ul className="mt-4 space-y-3">{rows.map((d) => <LeadRow key={d.id} d={d} sendingOn={cfg.draftFollowUpEnabled} />)}</ul>}
      </PageContainer>
    </div>
  )
}

function LeadRow({ d, sendingOn }: { d: BookingDraft; sendingOn: boolean }) {
  const name = [d.firstName, d.lastName].filter(Boolean).join(' ') || (d.purgedAt ? 'Details erased (retention)' : '—')
  const vehicle = [d.vehicleYear, d.vehicleMake === 'Trailer' ? null : d.vehicleMake, d.vehicleModel].filter(Boolean).join(' ')
  const [fuLabel, fuTone]: [string, BadgeTone] = d.followUpStatus === 'pending' && !sendingOn
    ? ['Allowed — sending is off', 'neutral']
    : FOLLOW_UP[d.followUpStatus] ?? [d.followUpStatus, 'neutral']
  return (
    <li className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-semibold">{name}</p>
          <p className="mt-0.5 break-words text-sm text-gray-300">
            {d.phone && <a href={`tel:${d.normalizedPhone ?? d.phone}`} className="underline-offset-2 hover:underline">{d.phone}</a>}
            {d.phone && d.email && ' · '}
            {d.email && <a href={`mailto:${d.email}`} className="underline-offset-2 hover:underline">{d.email}</a>}
          </p>
          <p className="mt-1 break-words text-sm text-gray-400">{d.serviceLabels || 'No service'}{vehicle ? ` · ${vehicle}` : ''}</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {d.status === 'booked' ? <Badge tone="positive">Booked</Badge> : d.status === 'purged' ? <Badge>Erased</Badge> : <Badge tone="warn">Not booked</Badge>}
          <span className="text-xs text-gray-500">Last activity {fmt(d.lastActivityAt)}</span>
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2"><dt className="text-gray-500">Follow-up permission:</dt><dd>{d.followUpConsent ? <>Yes, {fmt(d.followUpConsentAt)} <span className="text-gray-500">({d.followUpConsentVersion})</span></> : 'No'}</dd></div>
        <div className="flex flex-wrap items-center gap-2"><dt className="text-gray-500">Follow-up email:</dt><dd className="flex items-center gap-2"><Badge tone={fuTone}>{fuLabel}</Badge>{d.followUpSentAt && <span className="text-xs text-gray-400">{fmt(d.followUpSentAt)}</span>}
          {(d.followUpStatus === 'not_configured' || d.followUpStatus === 'failed') && d.status === 'open' && d.followUpConsent && d.staffStatus !== 'closed' && <RequeueFollowUp id={d.id} />}</dd></div>
        {d.followUpError && d.followUpStatus !== 'sent' && <div className="sm:col-span-2 text-xs text-gray-500">Note: {d.followUpError}</div>}
        {d.preferredDate && <div className="flex gap-2"><dt className="text-gray-500">Looked at:</dt><dd>{shortDate(d.preferredDate)}{d.preferredTime ? `, ${formatTimeLabel(d.preferredTime)}` : ''} <span className="text-gray-500">(not held)</span></dd></div>}
        {d.notes && <div className="sm:col-span-2 flex gap-2"><dt className="text-gray-500">Notes:</dt><dd className="break-words">{d.notes}</dd></div>}
        {d.appointmentId && <div className="flex gap-2"><dt className="text-gray-500">Appointment:</dt><dd><Link href={`/appointments/${d.appointmentId}`} className="text-emerald-300 underline">Open</Link></dd></div>}
      </dl>
      {d.status !== 'purged' && <div className="mt-3"><LeadStatusButtons id={d.id} status={d.staffStatus} /></div>}
    </li>
  )
}
