/**
 * POST /api/workflow/orders/[id]/invoice/override — flip one Invoice Draft charge and
 * recompute through the single fee engine, then audit it.
 *
 * Server-enforced permissions (NOT just hidden UI):
 *   • shop_supplies / payment  → manager or admin
 *   • tax_exempt               → admin only, and a reason is REQUIRED
 * Dealer Jobs carry no retail charges → overrides are rejected.
 * Every override writes a service_order_events audit row (actor, field, old→new, reason).
 * No QuickBooks writes.
 */
import { NextResponse } from 'next/server'
import { getOrderWithContext, logEvent } from '@/apps/workflow/db'
import { getEstimateRow, getFullEstimate, setEstimateWaiver, recomputeEstimate, flagQbSyncNeededIfInvoiced } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { isDealerOrder } from '@/apps/workflow/fees'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { getBusinessConfig } from '@/apps/settings/db'

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
  const est = await getEstimateRow(id)
  if (!est) return NextResponse.json({ error: 'This Job has no priced estimate yet.' }, { status: 400 })

  // Old value for the audit trail.
  const oldValue = field === 'shop_supplies' ? est.waiveShopSupplies : field === 'payment' ? est.waiveCardFee : est.taxExempt
  if (oldValue === removed) {
    // No-op (already in the requested state) — return the current draft without an audit entry.
    const [full, cfg] = await Promise.all([getFullEstimate(id), getBusinessConfig()])
    return NextResponse.json({ ok: true, draft: buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: actor.role }) })
  }

  await setEstimateWaiver(est.id, field, removed)
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

  const [full, cfg] = await Promise.all([getFullEstimate(id), getBusinessConfig()])
  return NextResponse.json({ ok: true, draft: buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: actor.role }) })
}
