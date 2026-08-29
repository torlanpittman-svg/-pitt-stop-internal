/**
 * Auto Sales — ADMIN inventory view (gated by proxy.ts /admin/*). Same shared InventoryView as the
 * public employee route, with admin=true (shows the opening-inventory import link). The employee
 * everyday tool lives at /auto-sales; this admin surface adds the sensitive/setup affordances.
 */
import InventoryView from '@/apps/auto-sales/ui/InventoryView'

export const dynamic = 'force-dynamic'

export default function AutoSalesAdminPage() {
  return <InventoryView admin={true} />
}
