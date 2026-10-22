/**
 * GET /api/workflow/orders/[id]/invoice — the manager/admin Invoice Draft for a retail
 * Job. Reads the authoritative estimate totals (no second calculation). Manager/admin
 * only. No QuickBooks writes anywhere. Dealer Jobs return isDealer with no retail charges.
 */
import { NextResponse } from 'next/server'
import { getOrderWithContext } from '@/apps/workflow/db'
import { getFullEstimate } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { getBusinessConfig, retailQbEnabled, retailQbSendEnabled, retailQbSyncEnabled, retailQbPaymentEnabled, retailQbSharedInvoiceEnabled, retailQbCombineInvoicesEnabled } from '@/apps/settings/db'
import { loadSharedInvoiceState } from '@/apps/quickbooks/shared-invoice'
import { loadCombineState } from '@/apps/quickbooks/invoice-consolidation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ error: 'Managers and admins only.' }, { status: 403 })
  }
  const order = await getOrderWithContext(id)
  if (!order) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const [full, cfg, qbEnabled, qbSendEnabled, qbSyncEnabled, qbPaymentEnabled, qbSharedEnabled, qbCombineEnabled, combine] = await Promise.all([getFullEstimate(id), getBusinessConfig(), retailQbEnabled(), retailQbSendEnabled(), retailQbSyncEnabled(), retailQbPaymentEnabled(), retailQbSharedInvoiceEnabled(), retailQbCombineInvoicesEnabled(), loadCombineState(id, actor.name)])
  // Read AFTER the combine state: reading it may record a combine finished from the other Job's screen.
  const shared = await loadSharedInvoiceState(id)
  // `shared`: this Job's shared-invoice state (either side) — shown even if the flag is later turned off, so a
  // linked Job never looks like it can be invoiced on its own.
  // `combine`: an unfinished (or the last finished) Combine unpaid invoices on either side — shown regardless of the
  // flag so a half-done combine always shows its recovery path.
  return NextResponse.json({ ok: true, qbEnabled, qbSendEnabled, qbSyncEnabled, qbPaymentEnabled, qbSharedEnabled, qbCombineEnabled, draft: { ...buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: actor.role }), shared, combine } })
}
