/**
 * POST /api/workflow/orders/[id]/remove — remove a mistaken/duplicate Job from the Work Board
 * (soft cancel). MANAGER + ADMIN only (server-enforced; employees denied). RETAIL or DEALER, but
 * ACTIVE only — a Ready/Delivered/Cancelled Job is refused. Never touches completed_at and never
 * calls QuickBooks; customer / vehicle / estimate / services / QB linkage remain intact, and a
 * dealer scan is flipped out of the QB queue so it can never re-batch (see removeOrder).
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { removeOrder } from '@/apps/workflow/db'
import { isRemovalAuthorizedRole } from '@/apps/workflow/removal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || !isRemovalAuthorizedRole(actor.role)) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  const result = await removeOrder({ orderId: id, actor: actor.name })
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
