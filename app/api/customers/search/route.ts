import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { searchCustomers } from '@/apps/directory/customer-profile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Customer directory search covering name, phone, email, AND owned-vehicle plate/VIN.
export async function GET(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })

  const q = new URL(req.url).searchParams.get('q') ?? ''
  if (q.trim().length < 2) return NextResponse.json({ ok: true, results: [] })

  const results = await searchCustomers(q, 25)
  return NextResponse.json({ ok: true, results })
}
