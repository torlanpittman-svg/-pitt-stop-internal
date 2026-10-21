import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import NavHeader from '@/app/components/NavHeader'
import { PageContainer } from '@/app/components/ui/PageHeader'
import { Badge } from '@/app/components/ui/Badge'
import { getDb } from '@/platform/db'
import { serviceOrders } from '@/apps/workflow/schema'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { getAppointment, listEvents } from '@/apps/appointments/db'
import { formatDateLabel, formatTimeLabel } from '@/apps/appointments/policy'
import { isFuture } from '@/apps/appointments/public'
import { STATUS_LABEL, STATUS_TONE, SOURCE_LABEL } from '../labels'
import AppointmentActions from './AppointmentActions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const fmt = (d: Date) => d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default async function AppointmentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await getAppointment(id)
  if (!a) notFound()
  const [events, mgr, order] = await Promise.all([
    listEvents(id), authorizedManager(),
    a.serviceOrderId ? getDb().select({ id: serviceOrders.id })
      .from(serviceOrders).where(eq(serviceOrders.id, a.serviceOrderId)).limit(1).then((r) => r[0] ?? null) : Promise.resolve(null),
  ])
  const vehicle = [a.vehicleYear, a.vehicleMake, a.vehicleModel].filter(Boolean).join(' ')
  const attribution = Object.entries(a.attribution ?? {})

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/appointments', label: 'Appointments' }} title={a.reference} />
      <PageContainer size="sm" className="py-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
          <Badge>{SOURCE_LABEL[a.source] ?? a.source}</Badge>
          {a.capacityOverride && <Badge tone="warn">Manager override</Badge>}
        </div>
        <h1 className="mt-3 text-2xl font-bold">
          {a.customerId
            ? <Link href={`/customers/${a.customerId}`} className="underline decoration-gray-600 underline-offset-4 hover:decoration-emerald-400">{a.firstName} {a.lastName}</Link>
            : <>{a.firstName} {a.lastName}</>}
        </h1>
        <p className="mt-1 text-lg text-gray-200">{formatDateLabel(a.localDate)} · {formatTimeLabel(a.localTime)} drop-off</p>

        <dl className="mt-5 divide-y divide-gray-800 rounded-xl border border-gray-800 bg-gray-900 text-sm">
          {([
            ['Service', a.serviceLabels],
            ['Vehicle', [vehicle, a.vehicleColor && `(${a.vehicleColor})`].filter(Boolean).join(' ')],
            ['Plate / VIN', [a.vehiclePlate, a.vehicleVin].filter(Boolean).join(' · ')],
            ['Phone', a.phone],
            ['Email', a.email ?? ''],
            ['Customer note', a.customerNotes ?? ''],
            ['Staff notes', a.internalNotes ?? ''],
            ['Booked', `${fmt(a.createdAt)}${a.createdBy ? ` by ${a.createdBy}` : ' online'}`],
          ] as const).filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="flex gap-3 px-4 py-2.5">
              <dt className="w-28 shrink-0 text-gray-500">{k}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-gray-200">
                {k === 'Phone' ? <a className="text-emerald-300" href={`tel:${v.replace(/[^\d+]/g, '')}`}>{v}</a> : v}
              </dd>
            </div>
          ))}
        </dl>

        {order && (
          <div className="mt-3 text-sm">
            <Link href={`/orders/${order.id}`} className="inline-flex min-h-11 items-center rounded-lg border border-emerald-800 px-4 text-emerald-200">View job</Link>
          </div>
        )}

        <AppointmentActions
          id={a.id} status={a.status} hasJob={!!a.serviceOrderId} isManager={!!mgr}
          past={!isFuture(a.startsAt)} date={a.localDate} time={a.localTime} serviceKeys={a.serviceKeys ?? []}
        />


        {attribution.length > 0 && (
          <section className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Marketing source</h2>
            <p className="mt-2 break-words text-sm text-gray-300">{attribution.map(([k, v]) => `${k}=${v}`).join(' · ')}</p>
          </section>
        )}

        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">History</h2>
          <ul className="mt-2 space-y-1 text-sm text-gray-300">
            {events.map((e) => (
              <li key={e.id}><span className="text-gray-500">{fmt(e.createdAt)}</span> · {e.eventType.replace('_', ' ')}{e.actor ? ` · ${e.actor}` : ''}
                {e.eventType === 'email_uncertain' && ` · ${(e.meta as { kind?: string }).kind ?? 'email'} may have been delivered (connection lost) — not resent`}
                {e.eventType === 'email_failed' && ` · ${(e.meta as { kind?: string }).kind ?? 'email'} was not delivered`}
                {e.eventType === 'rescheduled' && (() => { const m = e.meta as { from?: { date: string; time: string }; to?: { date: string; time: string } }; return m.from && m.to ? ` · ${m.from.date} ${m.from.time} → ${m.to.date} ${m.to.time}` : '' })()}
              </li>
            ))}
          </ul>
        </section>
      </PageContainer>
    </div>
  )
}
