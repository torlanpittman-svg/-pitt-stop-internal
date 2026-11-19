/**
 * Staff: Lead Recovery — cancelled appointments worth winning back. Managers/admins only, FAIL-CLOSED
 * (authorizedManagerStrict): it shows customer contact details. Employee-PIN gated in proxy.ts as well.
 * Reading this page never sends, queues or enrols anything; every change is an explicit button.
 */
import Link from 'next/link'
import { redirect } from 'next/navigation'
import NavHeader from '@/app/components/NavHeader'
import { PageContainer, PageHeader } from '@/app/components/ui/PageHeader'
import { Badge, type BadgeTone } from '@/app/components/ui/Badge'
import { authorizedManagerStrict } from '@/apps/auth/employee-guard'
import { getBookingConfig } from '@/apps/appointments/db'
import { formatTimeLabel } from '@/apps/appointments/policy'
import { transactionalEmailProvider } from '@/apps/appointments/notify'
import { checkRecoveryStream } from '@/apps/appointments/postmark-sync'
import { listRecoveries, listCandidates, type QueueItem, type QueueView, type Candidate, type ValueEstimate, type RecoveryEmailState } from '@/apps/appointments/recovery'
import { money, shortDate } from '@/app/lib/format'
import { RecoveryControls, EnrollButton } from './RecoveryControls'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const VIEWS = [['attention', 'Needs attention'], ['running', 'Follow-ups running'], ['rebooked', 'Rebooked'], ['closed', 'Closed'], ['candidates', 'Not in queue']] as const
type View = (typeof VIEWS)[number][0]

const STATUS: Record<string, [string, BadgeTone]> = {
  review: ['Needs review', 'warn'], active: ['Follow-ups running', 'info'], paused: ['Paused', 'neutral'],
  stopped: ['Stopped', 'neutral'], rebooked: ['Rebooked', 'positive'], finished: ['All emails sent — no rebooking', 'neutral'],
}
const ORIGIN: Record<string, string> = { customer: 'Customer cancelled', shop: 'Pitt Stop cancelled', unknown: 'Not recorded who cancelled' }
const OUTCOME: Record<string, string> = { contacted: 'Contacted', not_interested: 'Not interested', recovered: 'Marked recovered' }
const EMAIL: Record<string, [string, BadgeTone]> = {
  pending: ['Scheduled', 'info'], sending: ['Sending', 'info'], sent: ['Sent', 'positive'], failed: ['Failed', 'danger'],
  uncertain: ['May have been delivered', 'warn'], skipped: ['Not sent', 'neutral'], not_configured: ['Not sent — no email provider', 'warn'],
}
const when = (d: Date | string | null) => d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''

function Value({ v }: { v: ValueEstimate }) {
  if (v.minCents == null) return <span className="text-gray-400">No reliable estimate — none of these services has a single catalog price</span>
  return (
    <span>
      <span className="font-semibold text-white">{v.unpriced.length || v.priced.some((p) => p.from) ? 'At least ' : ''}{money(v.minCents)}</span>
      <span className="text-gray-400"> — {v.priced.map((p) => `${p.label} ${p.from ? 'from ' : ''}${money(p.cents)}`).join(', ')}
        {v.unpriced.length ? `; not priced: ${v.unpriced.join(', ')}` : ''}</span>
    </span>
  )
}

function emailSummary(emails: RecoveryEmailState[]): string {
  if (!emails.length) return 'No emails queued'
  return emails.map((e) => {
    const n = e.kind.slice(-1)
    const [label] = EMAIL[e.status] ?? [e.status]
    return `${n}: ${label}${e.status === 'sent' && e.sentAt ? ` ${when(e.sentAt)}` : e.status === 'pending' ? ` for ${when(e.sendAfter)}` : ''}`
  }).join(' · ')
}

export default async function LeadRecoveryPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (!(await authorizedManagerStrict())) redirect('/appointments')
  const sp = await searchParams
  const view: View = (VIEWS.map((v) => v[0]) as string[]).includes(sp.view ?? '') ? sp.view as View : 'attention'
  const cfg = await getBookingConfig()
  const [items, candidates] = await Promise.all([
    view === 'candidates' ? Promise.resolve([] as QueueItem[]) : listRecoveries(view as QueueView, { cfg }),
    view === 'candidates' ? listCandidates({ cfg }) : Promise.resolve([] as Candidate[]),
  ])
  const email = transactionalEmailProvider()
  const stream = email.live ? await checkRecoveryStream() : null
  const [d1, d2, d3] = cfg.recoveryDelayHours

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/appointments', label: 'Appointments' }} title="Lead Recovery" />
      <PageContainer className="py-6">
        <PageHeader kicker="Appointments" title="Lead Recovery"
          subtitle="Customers who booked and then cancelled. Highest-value work first." />
        <p className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm text-gray-300">
          Recovery emails: {cfg.recoveryEmailsEnabled
            ? <span className="text-emerald-300">ON — {cfg.recoveryAutoStart ? 'start automatically when a customer cancels' : 'a manager starts each one'}; emails at {d1} h, {d2} h and {d3} h, sent {cfg.recoverySendStartHour}:00–{cfg.recoverySendEndHour}:00</span>
            : <span className="text-amber-300">OFF — nothing is sent, automatically or by hand (turn on in Booking settings)</span>}
          {' · '}Provider: {email.live ? email.name : <span className="text-amber-300">none set up</span>}
          {stream && <>{' · '}Postmark stream “{stream.stream}”: {stream.ok
            ? <span className="text-emerald-300">ready (broadcast)</span>
            : <span className="text-red-300">NOT ready — {stream.problem} Recovery emails would fail until this is fixed.</span>}</>}
        </p>

        <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-gray-900" aria-label="Lead Recovery views">
          {VIEWS.map(([k, label]) => (
            <Link key={k} href={`/appointments/recovery?view=${k}`} aria-current={view === k ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${view === k ? 'border-emerald-400 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>{label}</Link>
          ))}
        </nav>

        {view === 'candidates' ? (
          <>
            <p className="mt-4 text-sm text-gray-400">Cancelled in the last 90 days and not in the queue. Nothing here is contacted. Adding one puts it in “Needs attention” — it does not start emails.</p>
            {!candidates.length
              ? <p className="mt-8 text-sm text-gray-400">No cancelled appointments outside the queue.</p>
              : <ul className="mt-4 space-y-3">{candidates.map((c) => <CandidateRow key={c.appointment.id} c={c} />)}</ul>}
          </>
        ) : !items.length
          ? <p className="mt-8 text-sm text-gray-400">{view === 'attention' ? 'Nothing needs attention.' : 'Nothing here yet.'}</p>
          : <ul className="mt-4 space-y-3">{items.map((r) => <RecoveryRow key={r.id} r={r} emailsOn={cfg.recoveryEmailsEnabled} />)}</ul>}
      </PageContainer>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-x-2"><dt className="text-gray-500">{label}:</dt><dd className="min-w-0 break-words">{children}</dd></div>
}

function RecoveryRow({ r, emailsOn }: { r: QueueItem; emailsOn: boolean }) {
  const [label, tone] = STATUS[r.status] ?? [r.status, 'neutral' as BadgeTone]
  const b = r.rebooked
  const rebookStatus = !b ? 'Not rebooked'
    : b.match === 'link' ? `Rebooked through the recovery link — ${b.reference}, ${shortDate(b.localDate)}`
    : b.match === 'staff' ? `Rebooked by staff from this queue — ${b.reference}, ${shortDate(b.localDate)}`
    : `Booked again (${b.reference}, ${shortDate(b.localDate)}${b.sameVehicle ? ', same vehicle' : ', different or unlisted vehicle'}) — ${b.review === 'pending' ? 'not yet confirmed as a recovery' : b.review === 'confirmed' ? 'confirmed as a recovery' : 'marked unrelated'}`
  return (
    <li className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-semibold">{r.customerName || '—'} <span className="font-normal text-gray-400">· {r.vehicle || 'Vehicle not given'}</span></p>
          <p className="mt-0.5 break-words text-sm text-gray-300">{r.serviceLabels || 'No service'}</p>
          <p className="mt-0.5 break-words text-sm text-gray-400">
            {r.phone && <a href={`tel:${r.phone}`} className="underline-offset-2 hover:underline">{r.phone}</a>}
            {r.phone && r.email && ' · '}
            {r.email && <a href={`mailto:${r.email}`} className="underline-offset-2 hover:underline">{r.email}</a>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <Badge tone={tone}>{label}</Badge>
          {r.tier >= 3 && <Badge tone="brand">High value</Badge>}
          {r.quickCancel && <Badge tone="info">Cancelled within 5 min of booking</Badge>}
          {r.staffOutcome && <span className="text-xs text-gray-400">{OUTCOME[r.staffOutcome]}</span>}
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Field label="Original appointment">{shortDate(r.localDate)}, {formatTimeLabel(r.localTime)} <span className="text-gray-500">({r.reference})</span></Field>
        <Field label="Cancelled">{when(r.cancelledAt)} <span className="text-gray-500">· {ORIGIN[r.origin]}</span></Field>
        <Field label="Cancellation reason">{r.cancelReason ?? <span className="text-gray-500">None given</span>}</Field>
        <Field label="Last contact">{r.lastContactAt ? when(r.lastContactAt) : <span className="text-gray-500">None</span>}</Field>
        <div className="sm:col-span-2"><Field label="Estimated value"><Value v={r.value} /></Field></div>
        <Field label="Email permission">{r.emailConsent ? 'On record' : <span className="text-gray-500">None on record</span>}</Field>
        <div className="sm:col-span-2"><Field label="Recovery emails">{emailSummary(r.emails)}{r.quickCancel ? ' · first email uses the “need a hand with your booking?” wording' : ''}</Field></div>
        <div className="sm:col-span-2"><Field label="Rebooking">{rebookStatus}</Field></div>
        {r.reason && <div className="sm:col-span-2 text-amber-200/90">{r.reason}</div>}
      </dl>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={`/appointments/${r.appointmentId}`} className="text-emerald-300 underline">Original appointment</Link>
        {r.customerId && <Link href={`/customers/${r.customerId}`} className="text-emerald-300 underline">Customer record</Link>}
        {b && <Link href={`/appointments/${b.appointmentId}`} className="text-emerald-300 underline">New appointment</Link>}
        {b?.orderId && <Link href={`/orders/${b.orderId}`} className="text-emerald-300 underline">Job</Link>}
        {r.status !== 'rebooked' && <Link href={`/appointments/new?recovery=${r.id}`} className="text-emerald-300 underline">Reschedule (book a new time)</Link>}
        <Link href={`/appointments/recovery/${r.id}/preview`} className="text-emerald-300 underline">Preview emails</Link>
      </div>
      <RecoveryControls id={r.id} status={r.status} outcome={r.staffOutcome} emailsOn={emailsOn} canEmail={r.origin !== 'shop' && !!r.email && r.emailConsent}
        needsConsent={r.origin !== 'shop' && !!r.email && !!r.customerId && !r.emailConsent}
        hasUnsent={r.emails.some((e) => e.status === 'pending')} matchPending={b?.match === 'contact' && b.review === 'pending'} />
    </li>
  )
}

function CandidateRow({ c }: { c: Candidate }) {
  const a = c.appointment
  const vehicle = [a.vehicleYear, a.vehicleMake === 'Trailer' ? null : a.vehicleMake, a.vehicleModel].filter(Boolean).join(' ')
  return (
    <li className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-semibold">{[a.firstName, a.lastName].filter(Boolean).join(' ')} <span className="font-normal text-gray-400">· {vehicle || 'Vehicle not given'}</span></p>
          <p className="mt-0.5 break-words text-sm text-gray-300">{a.serviceLabels}</p>
        </div>
        {c.verdict.enroll ? <Badge tone="positive">Recovery opportunity</Badge> : <Badge>Not eligible</Badge>}
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Field label="Original appointment">{shortDate(a.localDate)}, {formatTimeLabel(a.localTime)} <span className="text-gray-500">({a.reference})</span></Field>
        <Field label="Cancelled">{when(a.cancelledAt)} <span className="text-gray-500">· {ORIGIN[c.origin]}</span></Field>
        <Field label="Cancellation reason">{c.cancelReason ?? <span className="text-gray-500">None given</span>}</Field>
        <div className="sm:col-span-2"><Field label="Estimated value"><Value v={c.value} /></Field></div>
        {c.verdict.reason && <div className="sm:col-span-2 text-gray-400">{c.verdict.reason}</div>}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <Link href={`/appointments/${a.id}`} className="text-emerald-300 underline">Original appointment</Link>
        {(c.verdict.enroll || c.origin === 'shop') && <EnrollButton appointmentId={a.id} />}
      </div>
    </li>
  )
}
