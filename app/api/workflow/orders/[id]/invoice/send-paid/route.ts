/**
 * POST /api/workflow/orders/[id]/invoice/send-paid — "Email Paid Invoice": email the SAME QuickBooks
 * invoice, now confirmed paid, via QuickBooks' invoice send. MANAGER + ADMIN. Requires both
 * retail_qb_payment_enabled and retail_qb_send_enabled. Explicit action only — saving a payment never
 * emails. No Sales Receipt / new invoice / new sale is ever created.
 *
 * body { confirm: false }               → READ-ONLY: confirms paid in QuickBooks + resolves the recipient.
 * body { confirm: true }                → email once (a repeat tap reports already-sent, never re-emails).
 * body { confirm: true, resend: true }  → deliberate re-send of the paid invoice.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { retailQbPaymentEnabled, retailQbSendEnabled } from '@/apps/settings/db'
import { previewPaidInvoiceEmail, sendPaidRetailInvoice } from '@/apps/quickbooks/retail-payment-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  if (!(await retailQbPaymentEnabled()) || !(await retailQbSendEnabled())) {
    return NextResponse.json({ ok: false, error: 'Emailing paid invoices is turned off.' }, { status: 503 })
  }
  const body = await req.json().catch(() => ({})) as { confirm?: boolean; resend?: boolean; checkOnly?: boolean }
  if (!body?.confirm) return NextResponse.json({ ok: true, preview: await previewPaidInvoiceEmail(id) })
  const result = await sendPaidRetailInvoice({ orderId: id, actor: actor.name, resend: !!body.resend, checkOnly: !!body.checkOnly })
  const httpStatus = result.ok ? 200 : result.status === 'sending' || result.block === 'invoice_busy' ? 409 : result.status === 'uncertain' ? 202 : result.status === 'error' ? 502 : 400
  return NextResponse.json(result, { status: httpStatus })
}
