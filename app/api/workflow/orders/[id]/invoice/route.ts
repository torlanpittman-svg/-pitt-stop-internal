/**
 * GET /api/workflow/orders/[id]/invoice — the manager/admin Invoice Draft for a retail
 * Job. Reads the authoritative estimate totals (no second calculation). Manager/admin
 * only. No QuickBooks writes anywhere. Dealer Jobs return isDealer with no retail charges.
 */
import { NextResponse } from 'next/server'
import { getOrderWithContext } from '@/apps/workflow/db'
import { getFullEstimate } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { getActor } from '@/apps/workflow/identity'
import { getBusinessConfig } from '@/apps/settings/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ error: 'Managers and admins only.' }, { status: 403 })
  }
  const order = await getOrderWithContext(id)
  if (!order) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const [full, cfg] = await Promise.all([getFullEstimate(id), getBusinessConfig()])
  return NextResponse.json({ ok: true, draft: buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: actor.role }) })
}
