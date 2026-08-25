/**
 * POST /api/admin/finance/plaid/refresh — re-pull read-only balances for connected Items and
 * write fresh LIVE snapshots for verified-mapped accounts. Admin Basic-Auth gated. No money
 * movement, no QuickBooks writes.
 */
import { NextResponse } from 'next/server'
import { refreshPlaidBalances } from '@/apps/finance/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const r = await refreshPlaidBalances('admin')
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, { status: 500 })
  }
}
