/**
 * /quick-entry/services — Manage services (manager/admin only; employees are redirected).
 * Shortcuts, catalog descriptions/prices/QuickBooks items, review queue, alternate names.
 * The API enforces the same role check server-side.
 */
import { redirect } from 'next/navigation'
import { authenticatedActor, isManagerRole } from '@/apps/auth/employee-guard'
import ManageServices from './ManageServices'

export const dynamic = 'force-dynamic'

export default async function ManageServicesPage() {
  const actor = await authenticatedActor()
  if (!actor || !isManagerRole(actor.role)) redirect('/')
  return <ManageServices />
}
