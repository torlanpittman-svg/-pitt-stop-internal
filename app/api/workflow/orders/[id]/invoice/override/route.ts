/**
 * POST /api/workflow/orders/[id]/invoice/override — flip one Invoice Draft charge and
 * recompute through the single fee engine, then audit it.
 *
 * Server-enforced permissions (NOT just hidden UI):
 *   • shop_supplies / payment  → manager or admin
 *   • tax_exempt               → admin only, and a reason is REQUIRED
 * Dealer Jobs carry no retail charges → overrides are rejected; so is a cancelled Job/estimate (read-only).
 * Also used by the standalone Customer estimate (same Job estimate row, so the choice carries over to the
 * Work Board and into the QuickBooks estimate/invoice). An open estimate holds the intake lock, like
 * every other estimate edit, so a fee change can't interleave with a QuickBooks estimate send — and the
 * order is re-read UNDER that lock, so a cancel/convert that wins the race is rejected (not applied to a
 * stale read).
 * Every override writes a service_order_events audit row (actor, field, old→new, reason).
 * No QuickBooks writes.
 */
import { NextResponse } from 'next/server'
import { getOrderWithContext, logEvent } from '@/apps/workflow/db'
import { paymentLocksInvoice } from '@/apps/quickbooks/retail-payment'
import { getEstimateRow, getFullEstimate, setEstimateWaiver, recomputeEstimate, flagQbSyncNeededIfInvoiced } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { loadSharedInvoiceState } from '@/apps/quickbooks/shared-invoice'
import { isDealerOrder } from '@/apps/workflow/fees'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { getBusinessConfig } from '@/apps/settings/db'
import { withIntakeLock } from '@/apps/estimates/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Field = 'shop_supplies' | 'payment' | 'tax_exempt'
const FIELDS: Field[] = ['shop_supplies', 'payment', 'tax_exempt']

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ error: 'Managers and admins only.' }, { status: 403 })
  }

  const body = await req.json().catch(() => null) as { field?: string; removed?: boolean; reason?: string } | null
  const field = body?.field as Field
  const removed = body?.removed
  const reason = (body?.reason ?? '').trim()
  if (!FIELDS.includes(field) || typeof removed !== 'boolean') {
    return NextResponse.json({ error: 'field and removed (boolean) are required.' }, { status: 400 })
  }
  // Tax exemption is an admin-only override and must be justified.
  if (field === 'tax_exempt') {
    if (actor.role !== 'admin') return NextResponse.json({ error: 'Tax exemption is admin-only.' }, { status: 403 })
    if (removed && !reason) return NextResponse.json({ error: 'A reason is required to exempt tax.' }, { status: 400 })
  }

  const order = await getOrderWithContext(id)
  if (!order) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (isDealerOrder(order)) {
    return NextResponse.json({ error: 'Dealer Jobs have no retail charges.' }, { status: 400 })
  }
  if (order.status === 'cancelled') {
    return NextResponse.json({ error: 'This Job was cancelled. It is kept for history and can’t be changed.' }, { status: 409 })
  }
  if (order.status === 'estimate') {
    try {
      return await withIntakeLock(id, async () => {
        // Re-read UNDER the lock: a cancel or a Work Board conversion may have won the race between the
        // status check above and acquiring the lock. Reject unless it's still an open estimate, and
        // apply against the FRESH order so a stale read can't drive the charge change.
        const fresh = await getOrderWithContext(id)
        if (!fresh) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
        if (fresh.status !== 'estimate') {
          return NextResponse.json({ error: 'This estimate was just updated elsewhere (moved to the Work Board or cancelled). Reload and try again.' }, { status: 409 })
        }
        return applyOverride(id, fresh, actor, field, removed, reason)
      })
    }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not change that charge.' }, { status: 409 }) }
  }
  return applyOverride(id, order, actor, field, removed, reason)
}

async function applyOverride(
  id: string, order: NonNullable<Awaited<ReturnType<typeof getOrderWithContext>>>,
  actor: { name: string; role: string }, field: Field, removed: boolean, reason: string,
): Promise<NextResponse> {
  const est = await getEstimateRow(id)
  if (!est) return NextResponse.json({ error: 'This Job has no priced estimate yet.' }, { status: 400 })
  // A payment is recorded on the linked QuickBooks invoice — its charges can no longer change here.
  if (paymentLocksInvoice({ status: est.qbPaymentStatus, balanceState: est.qbPaymentBalanceState })) {
    return NextResponse.json({ error: 'A payment is recorded on this invoice — charges can’t be changed. Correct it in QuickBooks.' }, { status: 409 })
  }

  // Old value for the audit trail.
  const oldValue = field === 'shop_supplies' ? est.waiveShopSupplies : field === 'payment' ? est.waiveCardFee : est.taxExempt
  if (oldValue === removed) {
    // No-op (already in the requested state) — return the current draft without an audit entry.
    const [full, cfg] = await Promise.all([getFullEstimate(id), getBusinessConfig()])
    return NextResponse.json({ ok: true, draft: buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: actor.role }) })
  }

  // Atomic: refused if a payment was recorded / started after the check above (Record Payment's lock and
  // this write exclude each other on the same row).
  if (!(await setEstimateWaiver(est.id, field, removed))) {
    return NextResponse.json({ error: 'A payment is being recorded or is recorded on this invoice — charges can’t be changed. Correct it in QuickBooks.' }, { status: 409 })
  }
  await recomputeEstimate(est.id)
  // If a retail QB invoice is already linked, this charge change makes it stale → flag Sync.
  const qbSyncNeeded = await flagQbSyncNeededIfInvoiced(id, 'a charge changed')

  const labelFor: Record<Field, string> = { shop_supplies: 'Shop supplies', payment: 'Payment charge', tax_exempt: 'Tax exemption' }
  await logEvent({
    serviceOrderId: id,
    eventType: 'invoice_override',
    employeeName: actor.name,
    note: JSON.stringify({
      field: labelFor[field], key: field, action: removed ? 'removed' : 'restored',
      old: oldValue, new: removed, actorRole: actor.role, qbSyncNeeded, ...(field === 'tax_exempt' && removed ? { reason } : {}),
    }),
  })

  const [full, cfg, shared] = await Promise.all([getFullEstimate(id), getBusinessConfig(), loadSharedInvoiceState(id)])
  return NextResponse.json({ ok: true, draft: { ...buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: actor.role }), shared } })
}
