/**
 * POST /api/workflow/orders/[id]/services  { services: string[], addedBy?, confirmDuplicates? }
 *
 * Add operational services to a Work Board order's display list. Guards accidental
 * duplicates (returns needsConfirm). Logs a `service_added` audit event. Display-only:
 * NO QuickBooks / AutoLeap writes, no status/timing changes.
 */
import { NextResponse } from 'next/server'
import { addServiceToOrder, getOrderWithContext } from '@/apps/workflow/db'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { isDealerOrder } from '@/apps/workflow/fees'
import { getOrCreateEstimate, promoteTextServices, recomputeEstimate, removeServiceFromJob } from '@/apps/workflow/estimate-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * DELETE /api/workflow/orders/[id]/services  { service: string }
 * Remove a service (manager/admin only). Keeps service_orders.services + job_services +
 * pricing + completion in sync. Dealer Jobs are out of scope (blocked). No QB write —
 * a linked retail invoice is flagged "QuickBooks sync needed".
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const actor = await authenticatedActorFromRequest(req)
    if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
      return NextResponse.json({ ok: false, error: 'Only a manager or admin can remove a service.' }, { status: 403 })
    }
    const body = (await req.json().catch(() => ({}))) as { service?: string }
    const service = (body.service ?? '').trim()
    if (!service) return NextResponse.json({ ok: false, error: 'Which service?' }, { status: 400 })

    const order = await getOrderWithContext(id)
    if (!order) return NextResponse.json({ ok: false, error: 'Job not found' }, { status: 404 })
    if (isDealerOrder(order)) {
      return NextResponse.json({ ok: false, error: 'Dealer service handling is separate — not removable here.' }, { status: 400 })
    }

    const result = await removeServiceFromJob(id, service, actor.name)
    if (!result.removed) return NextResponse.json({ ok: true, order, changed: false })
    const updated = await getOrderWithContext(id)
    return NextResponse.json({ ok: true, order: updated, changed: true, pricingImpactCents: result.pricingImpactCents, qbSyncNeeded: result.qbSyncNeeded })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = (await req.json()) as { services?: string[]; addedBy?: string | null; confirmDuplicates?: boolean }
    const services = (body.services ?? []).map((s) => (s ?? '').trim()).filter(Boolean)
    if (services.length === 0) {
      return NextResponse.json({ ok: false, error: 'Select at least one service.' }, { status: 400 })
    }
    // Attribute to the authenticated employee (falls back to client-provided actor / 'staff').
    const addedBy = (await authenticatedActorFromRequest(req))?.name || body.addedBy || null
    const result = await addServiceToOrder(id, services, { addedBy, confirmDuplicates: body.confirmDuplicates })
    if (!result.ok) {
      return NextResponse.json({ ok: false, needsConfirm: true, duplicates: result.duplicates }, { status: 409 })
    }
    // Keep the unified job_services in sync with the employee-facing list (idempotent,
    // deduped). Best-effort: never fail Add Service if the estimate mirror hiccups.
    try {
      const est = await getOrCreateEstimate(id, addedBy)
      await promoteTextServices(est.id, id)
      await recomputeEstimate(est.id)
    } catch (err) {
      console.error('[add-service] unified job_services sync failed (service still added):', err)
    }
    return NextResponse.json({ ok: true, order: result.order })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
