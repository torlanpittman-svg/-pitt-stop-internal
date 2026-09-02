/**
 * POST /api/workflow/orders/[id]/reopen  { reason }
 *
 * Reopen a Ready Job (work was actually incomplete) — a sensitive correction. Requires the
 * authenticated identity to be a manager/admin (server-verified from the signed session, not a
 * client-writable cookie). A signed manager session already proves WHO is acting, so no separate
 * PIN re-confirmation is needed. Clears completed_at (preserving history in the audit event).
 */
import { NextResponse } from 'next/server'
import { reopenOrder } from '@/apps/workflow/db'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const actor = await authenticatedActorFromRequest(req)
    if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
      return NextResponse.json({ ok: false, error: 'Only a manager or admin can reopen.' }, { status: 403 })
    }
    const body = (await req.json().catch(() => ({}))) as { reason?: string }
    if (!body.reason?.trim()) return NextResponse.json({ ok: false, error: 'A reason is required.' }, { status: 400 })

    const result = await reopenOrder({ orderId: id, reason: body.reason, managerName: actor.name })
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 })
    return NextResponse.json({ ok: true, order: result.order })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
