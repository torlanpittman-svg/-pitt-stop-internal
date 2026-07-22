import { NextResponse } from 'next/server'
import { getEstimateWithDetails, updateEstimate } from '@/apps/estimator/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const estimate = await getEstimateWithDetails(id)
    if (!estimate) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json(estimate)
  } catch (err) {
    console.error('[estimator] GET /estimates/[id]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json() as Record<string, unknown>

    // Only allow mutable fields — never AI fields
    const allowed = [
      'vehicleYear', 'vehicleMake', 'vehicleModel', 'vehicleColor', 'vehicleSize',
      'vin', 'vehicleBodyClass', 'vinDecodeProvider', 'vinRawResponse', 'vehicleWasCorrected',
      'serviceFocus', 'status', 'approvedPriceCents', 'recommendedPriceCents',
      'estimateNumber', 'employeeId',
    ]

    const update: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body) update[key] = body[key]
    }

    const estimate = await updateEstimate(id, update)
    return NextResponse.json(estimate)
  } catch (err) {
    console.error('[estimator] PATCH /estimates/[id]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
