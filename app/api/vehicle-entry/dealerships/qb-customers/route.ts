/**
 * GET /api/vehicle-entry/dealerships/qb-customers?q=BMW
 * Manager-only, READ-ONLY QuickBooks customer search for "+ Add New Dealer" — lets the
 * manager pick the dealer's existing QB customer instead of typing an Id.
 */
import { NextResponse } from 'next/server'
import { searchCustomers } from '@/apps/quickbooks/customers'
import { getConnectionStatus } from '@/apps/quickbooks/connection'
import { authorizedManagerStrictFromRequest } from '@/apps/auth/employee-guard'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!(await authorizedManagerStrictFromRequest(request))) {
    return NextResponse.json({ error: 'Manager sign-in required' }, { status: 403 })
  }
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim()
  if (q.length < 2) return NextResponse.json({ customers: [] })

  const status = await getConnectionStatus()
  if (!status.connected) return NextResponse.json({ error: 'QuickBooks is not connected.' }, { status: 409 })
  try {
    const found = await searchCustomers(q.replace(/[\\%_]/g, '').slice(0, 100))
    const customers = found
      .filter((c) => c.active)
      .slice(0, 20)
      .map((c) => ({ id: c.id, displayName: c.displayName, email: c.email }))
    return NextResponse.json({ customers })
  } catch (err) {
    logger.error('vehicle-entry:dealerships', 'qb_customer_search_failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'QuickBooks search failed. Try again.' }, { status: 502 })
  }
}
