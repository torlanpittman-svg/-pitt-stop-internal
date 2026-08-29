/**
 * Auto Sales — EMPLOYEE vehicle folder (public, NOT admin-gated). Renders the shared VehicleFolderView
 * with admin=false and NO reverseAction — so the destructive "undo" control is never rendered or
 * reachable here. Employee-safe operations (add expense, sell/closeout, return/refund, VIN resolve)
 * work without the admin password.
 */
import VehicleFolderView from '@/apps/auto-sales/ui/VehicleFolderView'

export const dynamic = 'force-dynamic'

export default async function AutoSalesEmployeeFolderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <VehicleFolderView id={id} admin={false} />
}
