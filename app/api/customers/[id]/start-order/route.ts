import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { getCustomerProfile } from '@/apps/directory/customer-profile'
import { createServiceOrder, findActiveOrderByVehicleId } from '@/apps/workflow/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Start a new repair order that carries the selected customer + vehicle forward.
 * The vehicle MUST be linked to this customer (customer_vehicles) — fail closed otherwise so a
 * profile can never spin up an order against someone else's vehicle. If the vehicle already has an
 * active order, that order is returned instead of creating a duplicate.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => ({})) as { vehicleId?: string }
  const vehicleId = body.vehicleId?.trim()
  if (!vehicleId) return NextResponse.json({ ok: false, error: 'A vehicle is required.' }, { status: 400 })

  const profile = await getCustomerProfile(id)
  if (!profile) return NextResponse.json({ ok: false, error: 'Customer not found.' }, { status: 404 })

  const owns = profile.vehicles.some((v) => v.id === vehicleId)
  if (!owns) return NextResponse.json({ ok: false, error: 'That vehicle is not linked to this customer.' }, { status: 400 })

  const existing = await findActiveOrderByVehicleId(vehicleId)
  if (existing) return NextResponse.json({ ok: true, orderId: existing.id, existing: true })

  const order = await createServiceOrder({
    vehicleId,
    customerId: profile.id,
    customerName: profile.displayName,
    source: 'walk_in',
    checkedInBy: actor.name,
  })
  return NextResponse.json({ ok: true, orderId: order.id, existing: false })
}
