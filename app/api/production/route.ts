/**
 * GET /api/production?date=YYYY-MM-DD  → Daily Production Log (count-once).
 * Manager-elevation-gated (managers/admins only). Not accounting/admin — it's an
 * operational production report.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { completionEnabled } from '@/apps/workflow/completion'
import { dailyProduction, shopToday } from '@/apps/workflow/production'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!completionEnabled()) return NextResponse.json({ ok: false, error: 'not enabled' }, { status: 404 })
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Manager access required.' }, { status: 403 })
  }
  const date = new URL(req.url).searchParams.get('date') || shopToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: 'bad date' }, { status: 400 })
  const data = await dailyProduction(date)
  return NextResponse.json({ ok: true, ...data })
}
