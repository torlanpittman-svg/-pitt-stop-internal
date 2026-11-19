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
import { clearLink, decideLink, isLinkKind, vehicleMatchRiskById } from '@/apps/finance/purchase-links'
import { describeVehicleMatchRisk, isMatchResolution, resolveVehicleMatch, type VehicleMatchRiskView } from '@/apps/expenses/vehicle-link'
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
  // A match that keeps one purchase from counting twice on a vehicle is REFUSED here (server-side, whatever
  // posted the form) — it can only be changed through resolveAction below, with an explicit choice.
  if (id) await clearLink(id, 'admin')
  revalidatePath('/admin/finance/reconcile')
}
/** The owner's explicit answer for a receipt ↔ vehicle-expense match on one vehicle: keep it, confirm two
 *  different purchases (both count), or remove the duplicate typed vehicle expense (existing correction). */
async function resolveAction(fd: FormData) {
  'use server'
  const id = String(fd.get('id') ?? ''), resolution = String(fd.get('resolution') ?? '')
  if (!id || !isMatchResolution(resolution)) return
  const r = await resolveVehicleMatch(id, resolution, { name: 'admin' })
  revalidatePath('/admin/finance/reconcile')
  if (r.ok && r.inventoryVehicleId) { revalidatePath(`/auto-sales/${r.inventoryVehicleId}`); revalidatePath(`/admin/auto-sales/${r.inventoryVehicleId}`); revalidatePath('/auto-sales'); revalidatePath('/admin/auto-sales'); revalidatePath('/expenses/review') }
}

export default async function AdminReconcilePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams
  const days = sp.days === '30' ? 30 : sp.days === '90' ? 90 : 60
  const today = todayBusinessDate()
  const [data, owner] = await Promise.all([getReconciliation({ today, days, includeBank: true }), getOwnerReconciliation({ today, days })])
  // Which confirmed matches are the only thing keeping ONE purchase from counting twice on a vehicle.
  const vehicleRisks: Record<string, VehicleMatchRiskView> = {}
  for (const c of owner.confirmed) {
    if (c.kind !== 'receipt_vehicle_event' || !c.linkId) continue
    const risk = await vehicleMatchRiskById(c.linkId)
    if (risk) vehicleRisks[c.linkId] = await describeVehicleMatchRisk(risk)
  }
  return (
    <ReconcileView data={data} basePath="/admin/finance/reconcile" backHref="/admin/finance" backLabel="Finance">
      <OwnerMatches data={owner} decide={decideAction} clear={clearAction} resolve={resolveAction} vehicleRisks={vehicleRisks} />
    </ReconcileView>
  )
}
