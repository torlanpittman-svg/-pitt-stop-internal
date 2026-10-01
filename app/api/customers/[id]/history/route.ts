import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { getCustomerHistory, getVehicleServiceHistory, redactHistoryForEmployee } from '@/apps/directory/customer-profile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Paginated customer history. Employee-gated (defense-in-depth beyond middleware).
//   mode=own     → the customer's own transactions (pricing/invoice manager-only).
//   mode=vehicle → service on their vehicles they did NOT authorize (financial always stripped).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })

  const { id } = await params
  const url = new URL(req.url)
  const limit = Number(url.searchParams.get('limit') ?? '20')
  const offset = Number(url.searchParams.get('offset') ?? '0')
  const mode = url.searchParams.get('mode') === 'vehicle' ? 'vehicle' : 'own'

  const opts = { limit: Number.isFinite(limit) ? limit : 20, offset: Number.isFinite(offset) ? offset : 0 }
  const page = mode === 'vehicle' ? await getVehicleServiceHistory(id, opts) : await getCustomerHistory(id, opts)

  const manager = isManagerRole(actor.role)
  // Vehicle-scope rows are already financial-stripped server-side; employees get own-scope stripped too.
  const items = manager ? page.items : redactHistoryForEmployee(page.items)

  return NextResponse.json({ ok: true, ...page, items, manager, mode })
}
