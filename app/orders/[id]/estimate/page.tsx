/**
 * /orders/[id]/estimate — manager-only Estimate builder (Phase 3).
 * Server-gated on identity + ESTIMATE_LAYER_ENABLED; employees are redirected.
 */
import { cookies } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { parseActor, verifyElevation, effectiveRole } from '@/apps/workflow/identity'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { getOrderWithContext } from '@/apps/workflow/db'
import { getFullEstimate } from '@/apps/workflow/estimate-db'
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
  const full = await getFullEstimate(id)

  const header = {
    id,
    customer: order.customerName?.trim() || 'Unknown Customer',
    vehicle: [order.vehicle.year, order.vehicle.make, order.vehicle.model].filter(Boolean).join(' ') || 'Vehicle',
    requested: order.services ?? [],
  }
  return <EstimateBuilder header={header} initial={full} />
}
