import { NextResponse } from 'next/server'
import { getVehicleEntry, updateVehicleEntry } from '@/apps/vehicle-entry/db'
import { logger } from '@/platform/logger'

const LOG = 'api:vehicle-entry:entries'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const entry = await getVehicleEntry(id)
  if (!entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }
  return NextResponse.json(entry)
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const updated = await updateVehicleEntry(id, {
    year:                typeof body.year === 'string'           ? body.year              : undefined,
    make:                typeof body.make === 'string'           ? body.make              : undefined,
    model:               typeof body.model === 'string'          ? body.model             : undefined,
    color:               typeof body.color === 'string'          ? body.color             : undefined,
    customColor:         typeof body.customColor === 'string'    ? body.customColor       : undefined,
    stockNumber:         typeof body.stockNumber === 'string'    ? body.stockNumber       : undefined,
    wasCorrected:        typeof body.wasCorrected === 'boolean'  ? body.wasCorrected      : undefined,
    status:              typeof body.status === 'string'         ? (body.status as never) : undefined,
    employeeConfirmedAt: new Date(),
  })

  if (!updated) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }

  logger.info(LOG, 'entry.updated', { id, wasCorrected: body.wasCorrected, status: body.status })
  return NextResponse.json(updated)
}
