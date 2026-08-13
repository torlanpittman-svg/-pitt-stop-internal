/**
 * /orders/[id]/estimate — manager-only Estimate builder (Phase 3).
 * Server-gated on identity + ESTIMATE_LAYER_ENABLED; employees are redirected.
 */
import { cookies } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { parseActor, verifyElevation, effectiveRole } from '@/apps/workflow/identity'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { getOrderWithContext } from '@/apps/workflow/db'
import { prepareEstimateView } from '@/apps/workflow/estimate-db'
import EstimateBuilder from './EstimateBuilder'

export const dynamic = 'force-dynamic'

export default async function EstimatePage({ params }: { params: Promise<{ id: string }> }) {
  if (!estimateEnabled()) redirect('/')
  const c = await cookies()
  const role = effectiveRole(parseActor(c.get('ps_actor')?.value), verifyElevation(c.get('ps_elev')?.value))
  if (role !== 'manager' && role !== 'admin') redirect('/')

  const { id } = await params
  const order = await getOrderWithContext(id)
  if (!order) notFound()
  // Idempotent: ensure the estimate exists, mirror the Job's services, and seed suggested
  // prices for a truly fresh Job — so the manager sees a useful draft without an extra tap.
  // Never itemizes a flat (Quick Entry Work Price) Job just by opening the page.
  const actor = parseActor(c.get('ps_actor')?.value)
  const view = await prepareEstimateView(id, actor?.name ?? null)

  const header = {
    id,
    customer: order.customerName?.trim() || 'Unknown Customer',
    vehicle: [order.vehicle.year, order.vehicle.make, order.vehicle.model].filter(Boolean).join(' ') || 'Vehicle',
    requested: order.services ?? [],
  }
  return <EstimateBuilder header={header} initialView={view} />
}
