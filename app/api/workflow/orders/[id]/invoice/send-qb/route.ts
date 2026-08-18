/**
 * POST /api/workflow/orders/[id]/invoice/send-qb — email the EXISTING linked retail QB
 * invoice to the customer. MANAGER + ADMIN (server-enforced; employees denied). Gated by
 * retail_qb_send_enabled (default OFF). Never creates/clones/alters the invoice.
 *
 * body { confirm: false }              → READ-ONLY pre-send resolution (recipient + identity +
 *                                        total-integrity + not-stale), for the confirm dialog.
 * body { confirm: true }               → send the exact linked invoice once (idempotent; an
 *                                        already-sent invoice reconciles, never re-emails).
 * body { confirm: true, resend: true } → deliberate Resend of an already-sent invoice.
 */
import { NextResponse } from 'next/server'
import { getActor } from '@/apps/workflow/identity'
import { retailQbSendEnabled } from '@/apps/settings/db'
import { resolveRetailSend, sendRetailQBInvoice } from '@/apps/quickbooks/retail-invoice-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = getActor(req.headers.get('cookie'))
  // Send is manager + admin — employees are denied. Enforced here, not just in the UI.
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  if (!(await retailQbSendEnabled())) {
    return NextResponse.json({ ok: false, error: 'Retail invoice sending is disabled.' }, { status: 503 })
  }

  const body = await req.json().catch(() => ({})) as { confirm?: boolean; resend?: boolean }
  if (!body?.confirm) {
    // Read-only preview for the confirmation dialog.
    return NextResponse.json({ ok: true, preview: await resolveRetailSend(id) })
  }
  const result = await sendRetailQBInvoice({ orderId: id, actor: actor.name, resend: !!body.resend })
  const httpStatus = result.ok ? 200
    : result.block === 'no_invoice' ? 409
    : result.block === 'sending' ? 409
    : 400
  return NextResponse.json(result, { status: httpStatus })
}
