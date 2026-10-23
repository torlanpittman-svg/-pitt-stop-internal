import { NextResponse } from 'next/server'
import { listDealerships, createDealership } from '@/apps/vehicle-entry/db'
import { addDealership } from '@/apps/vehicle-entry/dealership-setup'
import { getCustomerById } from '@/apps/quickbooks/customers'
import { authorizedManagerStrictFromRequest } from '@/apps/auth/employee-guard'
import { logger } from '@/platform/logger'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const all = searchParams.get('all') === 'true'
  const items = await listDealerships(!all)
  return NextResponse.json(items)
}

// Manager-only "+ Add New Dealer". The dealer must already be a QuickBooks customer
// (verified live, read-only); nothing is written to QuickBooks.
export async function POST(request: Request) {
  const actor = await authorizedManagerStrictFromRequest(request)
  if (!actor) return NextResponse.json({ error: 'Manager sign-in required' }, { status: 403 })

  const body = await request.json().catch(() => null) as { qbCustomerId?: string; stockPrefix?: string | null; billingEmail?: string | null } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  try {
    const result = await addDealership(body, { listDealerships: () => listDealerships(false), getCustomerById, createDealership })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    logger.info('vehicle-entry:dealerships', result.created ? 'dealership.created' : 'dealership.exists', {
      actor: actor.key, dealershipId: result.dealership.id, qbCustomerId: result.dealership.qbCustomerId, stockPrefix: result.dealership.stockPrefix,
    })
    return NextResponse.json({ ...result.dealership, created: result.created }, { status: result.created ? 201 : 200 })
  } catch (err) {
    logger.error('vehicle-entry:dealerships', 'dealership.create_failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Could not add the dealer. Check the QuickBooks connection and try again.' }, { status: 500 })
  }
}
