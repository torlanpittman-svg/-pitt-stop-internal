/**
 * Receipts → Reconcile. MANAGER-gated (receiptManager, fail-closed). Read-only review queues that line
 * receipts up against the bank/card feed, jobs, expected bills and the sales-inventory ledger.
 *
 * Bank transactions and expected-bill detail are owner/admin data (the same as the CFO page): a manager PIN
 * sees the receipt-side queues here; the full view lives at /admin/finance/reconcile behind ADMIN_PASSWORD.
 */
import { redirect } from 'next/navigation'
import { receiptManager } from '@/apps/expenses/authz'
import { getReconciliation } from '@/apps/expenses/reconcile'
import { todayBusinessDate } from '@/apps/expenses/checks'
import ReconcileView from '@/apps/expenses/ui/ReconcileView'

export const dynamic = 'force-dynamic'

export default async function ReconcilePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const actor = await receiptManager()
  if (!actor) redirect('/expenses')
  const sp = await searchParams
  const days = sp.days === '30' ? 30 : sp.days === '90' ? 90 : 60
  const data = await getReconciliation({ today: todayBusinessDate(), days, includeBank: actor.role === 'admin' })
  return <ReconcileView data={data} basePath="/expenses/reconcile" backHref="/expenses/review" backLabel="Receipts" ownerHref="/admin/finance/reconcile" />
}
