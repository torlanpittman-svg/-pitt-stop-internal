import { NextResponse } from 'next/server'
import { createVehicleEntry, listVehicleEntries } from '@/apps/vehicle-entry/db'
import { logger } from '@/platform/logger'

const LOG = 'api:vehicle-entry:entries'

export async function GET() {
  const entries = await listVehicleEntries()
  return NextResponse.json(entries)
}

// Creates a blank entry for the manual-entry flow (no photo, no OCR).
// The employee fills in all fields on the confirm page.
export async function POST() {
  const id = await createVehicleEntry({ photoUrl: 'manual://no-photo' })
  logger.info(LOG, 'entry.manual.created', { id })
  return NextResponse.json({ id }, { status: 201 })
}
