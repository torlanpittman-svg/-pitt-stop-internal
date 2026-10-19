import { redirect } from 'next/navigation'
import NavHeader from '@/app/components/NavHeader'
import { PageContainer, PageHeader } from '@/app/components/ui/PageHeader'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { getBookingConfig, listUpcomingBlocks } from '@/apps/appointments/db'
import { bookingReadiness, localParts, federalHolidays } from '@/apps/appointments/policy'
import { transactionalEmailProvider } from '@/apps/appointments/notify'
import { publicBaseUrl } from '@/apps/appointments/tokens'
import SettingsForm from './SettingsForm'
import BlocksPanel from './BlocksPanel'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function AppointmentSettings() {
  if (!(await authorizedManager())) redirect('/appointments')
  const cfg = await getBookingConfig()
  const today = localParts(new Date(), cfg.timezone).date
  const blocks = await listUpcomingBlocks(today)
  const year = Number(today.slice(0, 4))
  const holidays = [...federalHolidays(year), ...federalHolidays(year + 1)].filter(([d]) => d >= today).slice(0, 8)
  const readiness = bookingReadiness(cfg)
  const email = transactionalEmailProvider()

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/appointments', label: 'Appointments' }} title="Booking settings" />
      <PageContainer size="sm" className="py-6">
        <PageHeader title="Booking settings" subtitle={`Public booking page: ${publicBaseUrl()}/book`} />
        {!readiness.ready && (
          <p className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/40 p-3 text-sm text-amber-200">
            Online booking can&apos;t turn on until these are set: {readiness.missing.join(', ')}.
          </p>
        )}
        <p className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm text-gray-300">
          Customer email: {email.live ? <span className="text-emerald-300">sending via {email.name}</span> : <span className="text-amber-300">no email provider set up — confirmations show on screen only</span>}.
        </p>
        <SettingsForm cfg={cfg} />
        <BlocksPanel blocks={blocks.map((b) => ({ id: b.id, kind: b.kind, date: b.localDate, time: b.localTime, reason: b.reason }))}
          holidays={cfg.federalHolidaysClosed ? holidays : []} />
      </PageContainer>
    </div>
  )
}
