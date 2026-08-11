/**
 * POST /api/workflow/orders/[id]/services  { services: string[], addedBy?, confirmDuplicates? }
 *
 * Add operational services to a Work Board order's display list. Guards accidental
 * duplicates (returns needsConfirm). Logs a `service_added` audit event. Display-only:
 * NO QuickBooks / AutoLeap writes, no status/timing changes.
 */
import { NextResponse } from 'next/server'
import { addServiceToOrder } from '@/apps/workflow/db'
import { getActor } from '@/apps/workflow/identity'
import { getOrCreateEstimate, promoteTextServices, recomputeEstimate } from '@/apps/workflow/estimate-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = (await req.json()) as { services?: string[]; addedBy?: string | null; confirmDuplicates?: boolean }
    const services = (body.services ?? []).map((s) => (s ?? '').trim()).filter(Boolean)
    if (services.length === 0) {
      return NextResponse.json({ ok: false, error: 'Select at least one service.' }, { status: 400 })
    }
    // Attribute to the active employee (falls back to client-provided actor / 'staff').
    const addedBy = getActor(req.headers.get('cookie'))?.name || body.addedBy || null
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
