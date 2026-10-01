import { notFound } from 'next/navigation'
import { authenticatedActor, isManagerRole } from '@/apps/auth/employee-guard'
import { getCustomerProfile, getCustomerHistory, getVehicleServiceHistory, redactHistoryForEmployee } from '@/apps/directory/customer-profile'
import CustomerDetail from './CustomerDetail'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const profile = await getCustomerProfile(id)
  if (!profile) notFound()

  const actor = await authenticatedActor()
  const manager = isManagerRole(actor?.role)

  const [ownPage, vehiclePage] = await Promise.all([
    getCustomerHistory(id, { limit: 20, offset: 0 }),
    getVehicleServiceHistory(id, { limit: 20, offset: 0 }),
  ])
  const ownItems = manager ? ownPage.items : redactHistoryForEmployee(ownPage.items)

  return (
    <CustomerDetail
      profile={profile}
      manager={manager}
      initialHistory={{ ...ownPage, items: ownItems }}
      initialVehicleHistory={vehiclePage}
    />
  )
}
