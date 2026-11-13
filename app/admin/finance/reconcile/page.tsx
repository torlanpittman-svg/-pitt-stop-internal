/**
 * CFO → Reconcile (owner/admin). /admin/* is gated by ADMIN_PASSWORD in proxy.ts, so this view includes the
 * bank-transaction and expected-bill queues that a manager PIN does not see at /expenses/reconcile.
 * READ-ONLY: nothing here matches, merges or posts anything; a bank match is confirmed on the CFO page.
 */
import { getReconciliation } from '@/apps/expenses/reconcile'
import { todayBusinessDate } from '@/apps/expenses/checks'
import ReconcileView from '@/apps/expenses/ui/ReconcileView'

export const dynamic = 'force-dynamic'

export default async function AdminReconcilePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams
  const days = sp.days === '30' ? 30 : sp.days === '90' ? 90 : 60
  const data = await getReconciliation({ today: todayBusinessDate(), days, includeBank: true })
  return <ReconcileView data={data} basePath="/admin/finance/reconcile" backHref="/admin/finance" backLabel="Finance" />
}
