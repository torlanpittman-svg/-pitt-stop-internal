/**
 * POST /api/workflow/orders/[id]/invoice/payment — Record Payment on the linked retail QB invoice.
 * MANAGER + ADMIN (server-enforced). Gated by retail_qb_payment_enabled (default OFF). Records money
 * ALREADY collected (cash / card terminal / check) as a QuickBooks Payment — never charges a card.
 *
 * body { action: 'preview' }                                   → verify the invoice, reconcile any payment
 *                                                                already in QuickBooks, return the open balance
 *                                                                + the methods that may be recorded. No QB write.
 *                                                                Cash / Check amounts come back with the card
 *                                                                charge removed (pricing engine; nothing changed).
 * body { action: 'record', method, amountCents, balanceCents, confirmationId, intent } → record ONE installment of money received
 *                                                                (integer cents, > 0, ≤ the open balance) against
 *                                                                the open balance the person confirmed; idempotent
 *                                                                (see apps/quickbooks/retail-payment-service.ts).
 *                                                                Cash / Check paying an unpaid invoice IN FULL:
 *                                                                removes the card charge, syncs the SAME invoice
 *                                                                and verifies it before paying. Partial amounts
 *                                                                never change the invoice.
 * body { action: 'record', method, confirmedAmountCents }      → older clients: full payment only (unchanged).
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { retailQbPaymentEnabled } from '@/apps/settings/db'
import { previewRetailPayment, recordRetailPayment } from '@/apps/quickbooks/retail-payment-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  if (!(await retailQbPaymentEnabled())) {
    return NextResponse.json({ ok: false, error: 'Recording payments is turned off.' }, { status: 503 })
  }
  const body = await req.json().catch(() => ({})) as { action?: string; method?: unknown; amountCents?: unknown; balanceCents?: unknown; confirmedAmountCents?: unknown; confirmationId?: unknown; intent?: unknown }
  if (body.action === 'record') {
    const result = await recordRetailPayment({
      orderId: id, actor: actor.name, method: body.method,
      ...('amountCents' in body ? { amountCents: body.amountCents, balanceCents: body.balanceCents, confirmationId: body.confirmationId, intent: body.intent } : { confirmedAmountCents: body.confirmedAmountCents }),
    })
    const httpStatus = result.ok ? 200
      : result.status === 'recording' || result.block === 'invoice_busy' ? 409
      : result.status === 'uncertain' || result.status === 'review' ? 202
      : result.status === 'error' ? 502
      : 400
    return NextResponse.json(result, { status: httpStatus })
  }
  return NextResponse.json(await previewRetailPayment({ orderId: id, actor: actor.name }))
}
