/**
 * Auto Sales — EMPLOYEE inventory (public, NOT admin-gated). Everyday operational tool employees use
 * from their phones: view inventory, acquire a vehicle, scan a VIN. Renders the shared InventoryView
 * with admin=false (hides the opening-inventory import). Same domain model as the admin route — no
 * second system, no duplicate data. Sensitive/admin functions live only under /admin/*.
 */
import InventoryView from '@/apps/auto-sales/ui/InventoryView'

export const dynamic = 'force-dynamic'

export default function AutoSalesEmployeePage() {
  return <InventoryView admin={false} />
}
