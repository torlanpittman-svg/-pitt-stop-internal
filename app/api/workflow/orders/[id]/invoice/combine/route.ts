/**
 * Combine unpaid invoices — /api/workflow/orders/[id]/invoice/combine. Manager/admin only (server-enforced; the
 * actor always comes from the signed session, never the body). Gated by retail_qb_combine_invoices_enabled (which
 * itself requires shared invoices + Create + Sync) for NEW combines (discover / preview / start). Recovery of an
 * unfinished combine (review / resume / cancel / separate) keeps working with that flag off — the kill switch never
 * strands a half-done combine — and needs only QuickBooks Create + Sync. Dealer Jobs are refused inside the service.
 *
 * GET                    → { enabled, state }                       this Job's combine state (DB only)
 * GET ?discover=1        → { enabled, state, discovery }            + this customer's other invoices (READ-ONLY QB)
 * POST { action: 'preview', otherOrderId, retainOrderId? }          READ-ONLY review of the combine
 * POST { action: 'start', retainedOrderId, replacedOrderId, requestId, expected, acknowledgeEmailed? }
 * POST { action: 'resume', syncToken?, combinedTotalCents?, confirmSent? }   retry / finish an unfinished combine
 * POST { action: 'review' }                                         READ-ONLY review of the retained invoice update
 * POST { action: 'cancel' }                                         stop before anything was written to QuickBooks
 * POST { action: 'separate' }                                       after the void: bill that vehicle separately
 * Nothing here ever sends an email.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { retailQbCombineInvoicesEnabled, retailQbCombineRecoveryEnabled } from '@/apps/settings/db'
import {
  findCombineCandidates, previewCombineInvoices, startCombineInvoices, resumeCombineInvoices, cancelCombineInvoices,
  separateCombineInvoices, loadCombineState, type CombineResult,
} from '@/apps/quickbooks/invoice-consolidation'
import { previewSharedInvoiceUpdate } from '@/apps/quickbooks/shared-invoice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function managerOnly(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) return { actor: null, denied: NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 }) }
  return { actor, denied: null }
}

const statusOf = (r: CombineResult) => (r.ok ? 200 : r.block === 'qb_read_failed' ? 502 : r.block === 'not_found' ? 404 : 409)

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { actor, denied } = await managerOnly(req)
  if (denied) return denied
  const enabled = await retailQbCombineInvoicesEnabled()
  const state = await loadCombineState(id, actor!.name)
  if (!enabled || !new URL(req.url).searchParams.get('discover')) return NextResponse.json({ ok: true, enabled, state })
  return NextResponse.json({ ok: true, enabled, state, discovery: await findCombineCandidates(id) })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { actor, denied } = await managerOnly(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as {
    action?: string; otherOrderId?: string; retainOrderId?: string; retainedOrderId?: string; replacedOrderId?: string; requestId?: string
    expected?: { retainedSyncToken?: string; replacedSyncToken?: string; combinedTotalCents?: number }
    acknowledgeEmailed?: boolean; syncToken?: string; combinedTotalCents?: number; confirmSent?: boolean
  }
  const name = actor!.name
  const recovery = body.action === 'review' || body.action === 'resume' || body.action === 'cancel' || body.action === 'separate'
  if (recovery ? !(await retailQbCombineRecoveryEnabled()) : !(await retailQbCombineInvoicesEnabled())) {
    return NextResponse.json({ ok: false, error: recovery ? 'QuickBooks invoicing is turned off, so this combine can’t be finished or undone right now.' : 'Combining invoices is turned off.' }, { status: 503 })
  }

  switch (body.action) {
    case 'preview': {
      if (!body.otherOrderId) return NextResponse.json({ ok: false, error: 'Choose the other invoice.' }, { status: 400 })
      return NextResponse.json(await previewCombineInvoices({ orderId: id, otherOrderId: String(body.otherOrderId), retainOrderId: body.retainOrderId ? String(body.retainOrderId) : null }))
    }
    case 'start': {
      const e = body.expected
      if (!body.retainedOrderId || !body.replacedOrderId || !body.requestId || !e?.retainedSyncToken || !e.replacedSyncToken || typeof e.combinedTotalCents !== 'number') {
        return NextResponse.json({ ok: false, error: 'Review the combine before confirming.' }, { status: 400 })
      }
      // The screen's Job must be one of the two (the route never acts on unrelated Jobs).
      if (id !== body.retainedOrderId && id !== body.replacedOrderId) return NextResponse.json({ ok: false, error: 'This Job isn’t part of that combine.' }, { status: 400 })
      const r = await startCombineInvoices({
        retainedOrderId: String(body.retainedOrderId), replacedOrderId: String(body.replacedOrderId), requestId: String(body.requestId).slice(0, 80), actor: name,
        expected: { retainedSyncToken: String(e.retainedSyncToken), replacedSyncToken: String(e.replacedSyncToken), combinedTotalCents: e.combinedTotalCents },
        acknowledgeEmailed: !!body.acknowledgeEmailed,
      })
      return NextResponse.json(r, { status: statusOf(r) })
    }
    case 'review': {
      const state = await loadCombineState(id, name)
      if (!state?.active) return NextResponse.json({ ok: false, error: 'No unfinished combine for this Job.' }, { status: 404 })
      return NextResponse.json(await previewSharedInvoiceUpdate(state.retained.orderId))
    }
    case 'resume': {
      const r = await resumeCombineInvoices({ orderId: id, actor: name, expectedSyncToken: body.syncToken ?? null, combinedTotalCents: typeof body.combinedTotalCents === 'number' ? body.combinedTotalCents : null, confirmSent: !!body.confirmSent })
      return NextResponse.json(r, { status: statusOf(r) })
    }
    case 'cancel': {
      const r = await cancelCombineInvoices({ orderId: id, actor: name })
      return NextResponse.json(r, { status: statusOf(r) })
    }
    case 'separate': {
      const r = await separateCombineInvoices({ orderId: id, actor: name })
      return NextResponse.json(r, { status: statusOf(r) })
    }
    default:
      return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 })
  }
}
