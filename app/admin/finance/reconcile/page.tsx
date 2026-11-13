/**
 * CFO → Reconcile (owner/admin). /admin/* is gated by ADMIN_PASSWORD in proxy.ts (server actions on this
 * path included). Shows the owner reconciliation (counted-once totals, bills vs payments, matches to confirm,
 * confirmed matches) above the shared review queues.
 *
 * The only writes are a person's own decisions (purchase_links) — nothing is auto-matched, nothing is posted
 * to QuickBooks, no money moves.
 */
import { revalidatePath } from 'next/cache'
import { getReconciliation } from '@/apps/expenses/reconcile'
import { todayBusinessDate } from '@/apps/expenses/checks'
import ReconcileView from '@/apps/expenses/ui/ReconcileView'
import { getOwnerReconciliation } from '@/apps/finance/reconcile-links'
import { clearLink, decideLink, isLinkKind } from '@/apps/finance/purchase-links'
import OwnerMatches from './OwnerMatches'

export const dynamic = 'force-dynamic'

async function decideAction(fd: FormData) {
  'use server'
  const kind = String(fd.get('kind') ?? ''), aId = String(fd.get('aId') ?? ''), bId = String(fd.get('bId') ?? ''), status = String(fd.get('status') ?? '')
  if (!isLinkKind(kind) || !aId || !bId || (status !== 'confirmed' && status !== 'dismissed')) return
  const amount = parseInt(String(fd.get('amount') ?? ''), 10)
  let evidence: unknown = null
  try { evidence = JSON.parse(String(fd.get('evidence') ?? 'null')) } catch { evidence = null }
  await decideLink({ kind, aId, bId, status, actor: 'admin', amountCents: Number.isFinite(amount) ? amount : null, evidence })
  revalidatePath('/admin/finance/reconcile')
}
async function clearAction(fd: FormData) {
  'use server'
  const id = String(fd.get('id') ?? '')
  if (id) await clearLink(id, 'admin')
  revalidatePath('/admin/finance/reconcile')
}

export default async function AdminReconcilePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams
  const days = sp.days === '30' ? 30 : sp.days === '90' ? 90 : 60
  const today = todayBusinessDate()
  const [data, owner] = await Promise.all([getReconciliation({ today, days, includeBank: true }), getOwnerReconciliation({ today, days })])
  return (
    <ReconcileView data={data} basePath="/admin/finance/reconcile" backHref="/admin/finance" backLabel="Finance">
      <OwnerMatches data={owner} decide={decideAction} clear={clearAction} />
    </ReconcileView>
  )
}
