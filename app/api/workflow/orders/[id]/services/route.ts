/**
 * POST /api/workflow/orders/[id]/services  { services: string[], addedBy?, confirmDuplicates? }
 *
 * Add operational services to a Work Board order's display list. Guards accidental
 * duplicates (returns needsConfirm). Logs a `service_added` audit event. Display-only:
 * NO QuickBooks / AutoLeap writes, no status/timing changes.
 */
import { NextResponse } from 'next/server'
import { addServiceToOrder } from '@/apps/workflow/db'

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
    const result = await addServiceToOrder(id, services, { addedBy: body.addedBy ?? null, confirmDuplicates: body.confirmDuplicates })
    if (!result.ok) {
      return NextResponse.json({ ok: false, needsConfirm: true, duplicates: result.duplicates }, { status: 409 })
    }
    return NextResponse.json({ ok: true, order: result.order })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
