import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { employeeAuthorizedFromRequest } from '@/apps/auth/employee-guard'
import { getDb } from '@/platform/db'
import { vehicles } from '@/apps/workflow/schema'
import { vehicleLabel } from '@/apps/quick-entry/customers'

export async function GET(req: Request) {
  if (!await employeeAuthorizedFromRequest(req)) return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
  const vin = (new URL(req.url).searchParams.get('vin') ?? '').trim().toUpperCase()
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return NextResponse.json({ error: 'Enter a 17-character VIN' }, { status: 400 })
  const [vehicle] = await getDb().select().from(vehicles).where(eq(vehicles.vin, vin)).orderBy(desc(vehicles.createdAt)).limit(1)
  return NextResponse.json({ vehicle: vehicle ? { id: vehicle.id, vin: vehicle.vin, year: vehicle.year, make: vehicle.make, model: vehicle.model, label: vehicleLabel(vehicle) } : null })
}
