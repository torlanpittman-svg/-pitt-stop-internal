/**
 * POST /api/workflow/orders/[id]/remove — remove a mistaken/duplicate Job from the Work Board
 * (soft cancel). MANAGER + ADMIN only (server-enforced; employees denied). RETAIL + ACTIVE
 * only — dealer Jobs and Ready/Delivered/Cancelled Jobs are refused. Never touches completed_at;
 * customer / vehicle / estimate / services / QuickBooks linkage remain intact (see removeOrder).
 */
import { NextResponse } from 'next/server'
import { getActor } from '@/apps/workflow/identity'
import { removeOrder } from '@/apps/workflow/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  const result = await removeOrder({ orderId: id, actor: actor.name })
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
