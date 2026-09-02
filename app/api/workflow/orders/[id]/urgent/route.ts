/**
 * POST /api/workflow/orders/[id]/urgent  { urgent: boolean }
 *
 * Set/clear a Job's operational URGENCY (visual + Work Board sort priority only). Any AUTHENTICATED
 * EMPLOYEE may toggle it — it is not a manager/invoice/status action. Requires the shared employee
 * session (defense-in-depth guard); never grants /admin, manager invoice authority, or QB writes.
 * No change to status, pricing, production value, or QuickBooks.
 */
import { NextResponse } from 'next/server'
import { setOrderUrgent } from '@/apps/workflow/db'
import { employeeAuthorizedFromRequest, authenticatedActorFromRequest } from '@/apps/auth/employee-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await employeeAuthorizedFromRequest(req))) {
    return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  }
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { urgent?: boolean }
  const urgent = body.urgent === true
  const actor = (await authenticatedActorFromRequest(req))?.name ?? 'employee'
  const row = await setOrderUrgent(id, urgent, actor)
  if (!row) return NextResponse.json({ ok: false, error: 'Job not found' }, { status: 404 })
  return NextResponse.json({ ok: true, isUrgent: row.isUrgent })
}
