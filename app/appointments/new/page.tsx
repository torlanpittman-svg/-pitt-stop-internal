import NavHeader from '@/app/components/NavHeader'
import { PageContainer, PageHeader } from '@/app/components/ui/PageHeader'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { getBookingConfig } from '@/apps/appointments/db'
import { localParts } from '@/apps/appointments/policy'
import NewAppointmentForm from './NewAppointmentForm'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function NewAppointmentPage() {
  const [cfg, mgr] = await Promise.all([getBookingConfig(), authorizedManager()])
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/appointments', label: 'Appointments' }} title="New appointment" />
      <PageContainer size="sm" className="py-6">
        <PageHeader title="New appointment" subtitle="Phone call, walk-in, Facebook, Google or marketing lead." />
        <NewAppointmentForm
          services={cfg.services.map((s) => ({ key: s.key, label: s.label, enabled: s.enabled }))}
          today={localParts(new Date(), cfg.timezone).date}
          isManager={!!mgr}
        />
      </PageContainer>
    </div>
  )
}
