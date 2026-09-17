import { redirect } from 'next/navigation'
import { managerActor } from '@/apps/checks/authz'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { listIntakes } from '@/apps/estimates/db'
import NavHeader from '@/app/components/NavHeader'
import EstimatesClient from './EstimatesClient'

export const dynamic = 'force-dynamic'
export default async function EstimatesPage() {
  if (!await managerActor() || !estimateEnabled()) redirect('/')
  const rows = await listIntakes()
  return <main className="min-h-screen bg-gray-950 text-white">
    <NavHeader title="Estimates" />
    <EstimatesClient rows={rows.map(({ order, vehicle, estimate, intake }) => ({
      id: order.id, customer: order.customerName || 'Customer',
      vehicle: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' '),
      total: estimate.totalCents, status: order.status === 'estimate' ? (intake.sentAt ? 'Sent' : 'Draft') : estimate.convertedAt ? 'On Work Board' : 'Archived',
      date: order.createdAt.toISOString(), qbNumber: intake.qbEstimateNumber,
    }))} />
  </main>
}
