/**
 * POST /api/workflow/orders/[id]/production-date — set or clear the Daily Production day
 * override for a completed Job. MANAGER + ADMIN only (server-enforced). Retail + dealer.
 *
 * body { date: 'YYYY-MM-DD' } → move the Job to that shop-calendar production day.
 * body { date: null }        → reset to the completed_at-derived day.
 *
 * Never modifies completed_at, the completion event, Job status, or any QuickBooks state.
 */
import { NextResponse } from 'next/server'
import { getActor } from '@/apps/workflow/identity'
import { getOrderWithContext, setProductionDateOverride } from '@/apps/workflow/db'
import { effectiveProductionDate, shopToday } from '@/apps/workflow/production'
import { shopTimezone } from '@/apps/workflow/completion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Current production-date state for the Job-detail section (effective day + override + the
// completed_at-derived day, all in the shop timezone). Manager/admin only.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  const order = await getOrderWithContext(id)
  if (!order) return NextResponse.json({ ok: false, error: 'Job not found' }, { status: 404 })
  const tz = shopTimezone()
  const completedDay = effectiveProductionDate(null, order.completedAt, tz)  // day derived from completed_at
  return NextResponse.json({
    ok: true,
    completed: !!order.completedAt,
    completedAt: order.completedAt ? (order.completedAt as unknown as Date).toISOString?.() ?? String(order.completedAt) : null,
    completedDay,
    override: order.productionDateOverride ?? null,
    effective: effectiveProductionDate(order.productionDateOverride, order.completedAt, tz),
    today: shopToday(tz),
    tz,
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({})) as { date?: string | null }
  const date = body?.date == null ? null : String(body.date)
  const result = await setProductionDateOverride({ orderId: id, date, actor: actor.name })
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
