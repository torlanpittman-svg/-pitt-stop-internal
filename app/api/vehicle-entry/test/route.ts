import { NextResponse } from 'next/server'
import { createVehicleEntry } from '@/apps/vehicle-entry/db'

export async function POST(request: Request) {
  const id = await createVehicleEntry({
    photoUrl: 'test://debug-button',
    year: '2021',
    make: 'Toyota',
    model: 'Tacoma',
    color: 'White',
    stockNumber: 'PS-TEST-01',
    ocrConfidence: { year: 0.97, make: 0.95, model: 0.89, color: 0.91, stockNumber: 0.71 },
    rawOcrResponse: { source: 'debug-test-button' },
  })

  // Plain HTML form POST — browser sends application/x-www-form-urlencoded.
  // Redirect so the browser lands on the confirm page instead of showing JSON.
  const ct = request.headers.get('content-type') ?? ''
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    return Response.redirect(new URL(`/vehicle-entry/confirm/${id}`, request.url), 303)
  }

  return NextResponse.json({ id })
}
