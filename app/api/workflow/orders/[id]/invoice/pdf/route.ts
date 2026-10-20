/**
 * GET /api/workflow/orders/[id]/invoice/pdf — the linked retail invoice PDF exactly as QuickBooks renders
 * it for the customer ("Print Paid Invoice"). MANAGER + ADMIN. Read-only; dealer jobs refused.
 */
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { getEstimateRow } from '@/apps/workflow/estimate-db'
import { getOrderWithContext } from '@/apps/workflow/db'
import { isDealerOrder } from '@/apps/workflow/fees'
import { getRetailInvoicePdf } from '@/apps/quickbooks/retail-payment-write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) return Response.json({ error: 'Managers and admins only.' }, { status: 403 })
  const [est, order] = await Promise.all([getEstimateRow(id), getOrderWithContext(id)])
  if (!order || !est?.qbInvoiceId) return Response.json({ error: 'No QuickBooks invoice is linked.' }, { status: 404 })
  if (isDealerOrder(order)) return Response.json({ error: 'Dealer invoices are handled by Dealer Check-In.' }, { status: 400 })
  try {
    const pdf = await getRetailInvoicePdf(est.qbInvoiceId)
    return new Response(pdf, { headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${(est.qbInvoiceNumber ?? est.qbInvoiceId).replace(/[^A-Za-z0-9-]/g, '')}.pdf"`,
      'Cache-Control': 'no-store',
    } })
  } catch {
    return Response.json({ error: 'Could not load the invoice PDF from QuickBooks.' }, { status: 502 })
  }
}
