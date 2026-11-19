import NavHeader from '@/app/components/NavHeader'
import { PageContainer, PageHeader } from '@/app/components/ui/PageHeader'
import { authorizedManager, authorizedManagerStrict } from '@/apps/auth/employee-guard'
import { getAppointment, getBookingConfig } from '@/apps/appointments/db'
import { getRecovery } from '@/apps/appointments/recovery'
import { localParts } from '@/apps/appointments/policy'
import NewAppointmentForm from './NewAppointmentForm'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<{ recovery?: string }> }) {
  const [cfg, mgr] = await Promise.all([getBookingConfig(), authorizedManager()])
  // "Reschedule" from Lead Recovery: the cancelled appointment's details, for managers only (same rule as the queue).
  const { recovery: recoveryId } = await searchParams
  const rec = recoveryId && (await authorizedManagerStrict()) ? await getRecovery(recoveryId) : null
  const from = rec && rec.status !== 'rebooked' ? await getAppointment(rec.appointmentId) : null
  const prefill = rec && from ? {
    recoveryId: rec.id, reference: from.reference, serviceKeys: from.serviceKeys ?? [],
    firstName: from.firstName, lastName: from.lastName, phone: from.phone, email: from.email ?? '',
    year: from.vehicleYear ?? '', make: from.vehicleMake ?? '', model: from.vehicleModel ?? '', color: from.vehicleColor ?? '',
    plate: from.vehiclePlate ?? '', vin: from.vehicleVin ?? '',
  } : null
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/appointments', label: 'Appointments' }} title="New appointment" />
      <PageContainer size="sm" className="py-6">
        <PageHeader title="New appointment" subtitle="Phone call, walk-in, Facebook, Google or marketing lead." />
        <NewAppointmentForm
          services={cfg.services.map((s) => ({ key: s.key, label: s.label, enabled: s.enabled }))}
          today={localParts(new Date(), cfg.timezone).date}
          isManager={!!mgr}
          prefill={prefill}
        />
      </PageContainer>
    </div>
  )
}
