/**
 * GET /api/workflow/orders/[id]/items — the Job screen's Services + Parts view for ANY valid shop
 * session (individual or shared-PIN). STRICTLY READ-ONLY: opening or refreshing a Job creates no
 * estimate, mirrors no service rows and recalculates nothing. It is the SAME authoritative estimate
 * view the manager's Invoice page uses (getEstimateView): service prices and part line amounts are the
 * customer's charges, computed once there. Non-managers get OUR COST stripped (internal only).
 * A Job service that exists only as Work Board text (older Jobs / no estimate yet) is shown by the
 * Job screen from the Job's own list; it gets an estimate row only inside an explicit add
 * (addPartForJob attaching by title runs the same idempotent mirror Add Service uses).
 */
import { NextResponse } from 'next/server'
import { employeeAuthorizedFromRequest, shopActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { getEstimateView, getEstimateRow, estimateHasQbInvoice } from '@/apps/workflow/estimate-db'
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
  const est = await getEstimateRow(id)   // read: the persisted QuickBooks linkage below
  const view = redactItemsView(await getEstimateView(id), manager)
  // Same reversible rollout gate as the parts tracker: when Parts is hidden from this viewer, no part data leaves.
  if (!partsVisible) view.parts = []
  // Persisted QuickBooks linkage (the removal rule's authority) — the server enforces it on every removal regardless.
  return NextResponse.json({ ok: true, view: { ...view, qbInvoiced: estimateHasQbInvoice(est) }, manager, partsVisible })
}
