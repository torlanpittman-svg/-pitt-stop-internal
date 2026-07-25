import { NextResponse } from 'next/server'
import { validateVIN, normalizeVIN, decodeVINFromNHTSA } from '@/apps/vehicle-entry/vin'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await request.json() as { vin?: string }
    if (!body.vin) return NextResponse.json({ error: 'Missing vin' }, { status: 400 })

    const { valid, error } = validateVIN(body.vin)
    if (!valid) return NextResponse.json({ error }, { status: 422 })

    const vin = normalizeVIN(body.vin)
    const decoded = await decodeVINFromNHTSA(vin)

    return NextResponse.json({
      vin:       decoded.vin,
      year:      decoded.year,
      make:      decoded.make,
      model:     decoded.model,
      bodyClass: decoded.bodyClass,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'VIN lookup unavailable — enter vehicle details manually' },
      { status: 502 }
    )
  }
}
