/**
 * POST /api/workflow/orders/[id]/invoice/create-qb — create a retail QuickBooks invoice
 * from the authoritative Invoice Draft. Manager/admin only (server-enforced). Gated by the
 * retail_qb_enabled flag (default OFF). NO send, NO customer email. Idempotent / duplicate-
 * proof (see retail-invoice-service). Dealer invoicing is untouched.
 */
import { NextResponse } from 'next/server'
import { getActor } from '@/apps/workflow/identity'
import { retailQbEnabled } from '@/apps/settings/db'
import { createRetailQBInvoice } from '@/apps/quickbooks/retail-invoice-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  if (!(await retailQbEnabled())) {
    return NextResponse.json({ ok: false, error: 'Retail QuickBooks invoicing is disabled.' }, { status: 503 })
  }
  const body = await req.json().catch(() => ({})) as { requestId?: string }
  const result = await createRetailQBInvoice({ orderId: id, actor: actor.name, requestId: body?.requestId ?? null })
  const httpStatus = result.ok ? 200 : (result.status === 'creating' ? 409 : 400)
  return NextResponse.json(result, { status: httpStatus })
}
