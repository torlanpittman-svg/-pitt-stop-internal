/**
 * POST /api/workflow/orders/[id]/invoice/sync-qb — UPDATE the EXISTING linked retail QB
 * invoice in place from the authoritative Invoice Draft (Phase C). Manager/admin only
 * (server-enforced). Gated by retail_qb_sync_enabled AND retail_qb_enabled (default OFF).
 * NEVER creates a second invoice, never sends, never repoints the QB customer.
 *
 * body { confirm: false } → READ-ONLY pre-sync resolution (identity + already-sent), for the
 *                           confirmation/preview dialog.
 * body { confirm: true, confirmSent?: true } → perform the sync (confirmSent required only
 *                           when the invoice was already emailed).
 */
import { NextResponse } from 'next/server'
import { getActor } from '@/apps/workflow/identity'
import { retailQbEnabled, retailQbSyncEnabled } from '@/apps/settings/db'
import { resolveRetailSync, syncRetailQBInvoice } from '@/apps/quickbooks/retail-invoice-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  // Sync requires BOTH flags: you can't sync what you can't create.
  const [syncOn, createOn] = await Promise.all([retailQbSyncEnabled(), retailQbEnabled()])
  if (!syncOn || !createOn) {
    return NextResponse.json({ ok: false, error: 'Retail QuickBooks sync is disabled.' }, { status: 503 })
  }

  const body = await req.json().catch(() => ({})) as { confirm?: boolean; confirmSent?: boolean }
  if (!body?.confirm) {
    return NextResponse.json({ ok: true, preview: await resolveRetailSync(id) })
  }
  const result = await syncRetailQBInvoice({ orderId: id, actor: actor.name, confirmSent: !!body.confirmSent })
  const httpStatus = result.ok ? 200
    : result.block === 'no_invoice' ? 409
    : result.block === 'syncing' ? 409
    : result.block === 'confirm_required' ? 409
    : 400
  return NextResponse.json(result, { status: httpStatus })
}
