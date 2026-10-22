/**
 * Shared retail invoice — /api/workflow/orders/[id]/invoice/shared. Manager/admin only (server-enforced; employee
 * intake never calls this and is refused if it does). Gated by retail_qb_shared_invoice_enabled (+ Create + Sync).
 * Dealer Jobs are refused inside the service before any customer or QuickBooks lookup.
 *
 * GET                       → { enabled, state }            this Job's shared-invoice state (DB only)
 * GET ?discover=1           → { enabled, state, discovery }  + eligible open invoices (READ-ONLY QuickBooks lookup)
 * POST { action: 'link', anchorOrderId, invoiceId, syncToken, requestId }   link as a PENDING member (no QB write)
 * POST { action: 'unlink', reason? }                                         keep separate (pending members only)
 * POST { action: 'preview' }                                                 READ-ONLY vehicle breakdown + total
 * POST { action: 'update', syncToken, confirmSent? }                         reviewed update of the SAME invoice
 * Nothing here ever sends an email.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { retailQbSharedInvoiceEnabled } from '@/apps/settings/db'
import {
  findSharedInvoiceCandidates, linkToSharedInvoice, unlinkSharedInvoiceMember, loadSharedInvoiceState,
  previewSharedInvoiceUpdate, updateSharedInvoice,
} from '@/apps/quickbooks/shared-invoice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function managerOnly(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) return { actor: null, denied: NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 }) }
  return { actor, denied: null }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { denied } = await managerOnly(req)
  if (denied) return denied
  const enabled = await retailQbSharedInvoiceEnabled()
  const state = await loadSharedInvoiceState(id)
  if (!enabled || !new URL(req.url).searchParams.get('discover')) return NextResponse.json({ ok: true, enabled, state })
  const discovery = await findSharedInvoiceCandidates(id)
  return NextResponse.json({ ok: true, enabled, state, discovery })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { actor, denied } = await managerOnly(req)
  if (denied) return denied
  if (!(await retailQbSharedInvoiceEnabled())) return NextResponse.json({ ok: false, error: 'Shared invoices are turned off.' }, { status: 503 })
  const body = await req.json().catch(() => ({})) as { action?: string; anchorOrderId?: string; invoiceId?: string; syncToken?: string; requestId?: string; confirmSent?: boolean; reason?: string }

  switch (body.action) {
    case 'link': {
      if (!body.anchorOrderId || !body.invoiceId) return NextResponse.json({ ok: false, error: 'Choose an invoice.' }, { status: 400 })
      const r = await linkToSharedInvoice({ orderId: id, anchorOrderId: String(body.anchorOrderId), invoiceId: String(body.invoiceId), expectedSyncToken: body.syncToken ?? null, requestId: body.requestId ? String(body.requestId).slice(0, 80) : null, actor: actor!.name })
      return NextResponse.json(r, { status: r.ok ? 200 : r.block === 'qb_read_failed' ? 502 : 409 })
    }
    case 'unlink': {
      const r = await unlinkSharedInvoiceMember({ orderId: id, actor: actor!.name, reason: body.reason ? String(body.reason).slice(0, 200) : null })
      return NextResponse.json(r, { status: r.ok ? 200 : 409 })
    }
    case 'preview':
      return NextResponse.json(await previewSharedInvoiceUpdate(id))
    case 'update': {
      const r = await updateSharedInvoice({ orderId: id, actor: actor!.name, confirmSent: !!body.confirmSent, expectedSyncToken: body.syncToken ?? null })
      const status = r.ok ? 200 : (r.block === 'confirm_required' || r.block === 'syncing' || r.block === 'stale') ? 409 : 400
      return NextResponse.json(r, { status })
    }
    default:
      return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 })
  }
}
