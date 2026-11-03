/**
 * GET /api/workflow/orders/[id]/items — the Job screen's Services + Parts view for ANY valid shop
 * session (individual or shared-PIN). Read-only. It is the SAME authoritative estimate view the
 * manager's Invoice page uses (getEstimateView): service prices and part line amounts are the
 * customer's charges, computed once there. Non-managers get OUR COST stripped (internal only).
 * Nothing is created or mirrored here (no estimate is created for a Job that has none).
 */
import { NextResponse } from 'next/server'
import { employeeAuthorizedFromRequest, shopActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { getEstimateView, getEstimateRow, promoteTextServices, recomputeEstimate, estimateHasQbInvoice } from '@/apps/workflow/estimate-db'
import { partsVisibleFor } from '@/apps/parts/visibility'
import { redactItemsView } from '@/apps/parts/job-items-view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await employeeAuthorizedFromRequest(req))) {
    return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  }
  if (!estimateEnabled()) return NextResponse.json({ ok: false, error: 'not enabled' }, { status: 404 })
  const { id } = await params
  const actor = await shopActorFromRequest(req)
  const manager = isManagerRole(actor?.role)
  const partsVisible = partsVisibleFor(manager)
  // Keep the estimate's rows in step with the Job's text services (the same idempotent mirror Add Service
  // runs) so every listed service has a row a part can attach to. Only when an estimate already exists —
  // never creates one. Best-effort: a mirror hiccup never hides the list.
  const est = await getEstimateRow(id)
  try {
    if (est && (await promoteTextServices(est.id, id)) > 0) await recomputeEstimate(est.id)
  } catch (err) {
    console.error('[items] service mirror failed (list still served):', err)
  }
  const view = redactItemsView(await getEstimateView(id), manager)
  // Same reversible rollout gate as the parts tracker: when Parts is hidden from this viewer, no part data leaves.
  if (!partsVisible) view.parts = []
  // Persisted QuickBooks linkage (the removal rule's authority) — the server enforces it on every removal regardless.
  return NextResponse.json({ ok: true, view: { ...view, qbInvoiced: estimateHasQbInvoice(est) }, manager, partsVisible })
}
