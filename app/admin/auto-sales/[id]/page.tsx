/**
 * Auto Sales — ADMIN vehicle folder (gated by proxy.ts /admin/*). Renders the shared VehicleFolderView
 * with admin=true and passes the gated `reverse` action — so the destructive "undo"/reversal control
 * is ONLY defined and reachable through this admin route (never on the public /auto-sales surface).
 * All other (operational) actions come from the shared employee-safe module. No money movement.
 */
import { revalidatePath } from 'next/cache'
import { reverseEvent } from '@/apps/auto-sales/db'
import VehicleFolderView from '@/apps/auto-sales/ui/VehicleFolderView'

export const dynamic = 'force-dynamic'

// Admin-only destructive correction (append-only reversal). Defined here in the gated route module so
// it is never bundled into / invokable from the public employee route.
async function reverse(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? ''); const eventId = String(fd.get('eventId') ?? '')
  if (eventId) await reverseEvent(eventId, 'admin')
  revalidatePath(`/admin/auto-sales/${id}`); revalidatePath(`/auto-sales/${id}`)
}

export default async function AutoSalesAdminFolderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <VehicleFolderView id={id} admin={true} reverseAction={reverse} />
}
