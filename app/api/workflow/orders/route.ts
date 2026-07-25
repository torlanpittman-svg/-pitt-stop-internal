import { NextResponse } from 'next/server'
import {
  listActiveOrders,
  createServiceOrder,
  findOrCreateVehicle,
  getOrCreateDefaultLocation,
} from '@/apps/workflow/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const orders = await listActiveOrders()
    return NextResponse.json({ orders })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      vin?:          string
      year?:         string
      make?:         string
      model?:        string
      color?:        string
      licensePlate?: string
      bodyClass?:    string
      vinRaw?:       unknown
      source?:       string
      serviceType?:  string
      serviceFocus?: string
      checkedInBy?:  string
      notes?:        string
    }

    const location = await getOrCreateDefaultLocation()
    const vehicle  = await findOrCreateVehicle({
      vin:          body.vin,
      year:         body.year,
      make:         body.make,
      model:        body.model,
      color:        body.color,
      licensePlate: body.licensePlate,
      bodyClass:    body.bodyClass,
      vinRaw:       body.vinRaw,
    })

    const order = await createServiceOrder({
      vehicleId:    vehicle.id,
      locationId:   location.id,
      source:       body.source,
      serviceType:  body.serviceType,
      serviceFocus: body.serviceFocus,
      checkedInBy:  body.checkedInBy,
      notes:        body.notes,
    })

    return NextResponse.json({ order, vehicle }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
