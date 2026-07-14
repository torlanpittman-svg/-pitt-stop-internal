import { NextResponse } from 'next/server'
import { createVehicleEntry, getDealership } from '@/apps/vehicle-entry/db'
import { validateVIN, normalizeVIN, buildStockNumber } from '@/apps/vehicle-entry/vin'
import { logger } from '@/platform/logger'

const LOG = 'api:vehicle-entry:vin-entry'

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    vin:            string
    year:           string | null
    make:           string | null
    model:          string | null
    color:          string
    dealershipId:   string
    dealershipName: string
    stockPrefix:    string
  } | null

  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { valid, error } = validateVIN(body.vin)
  if (!valid) return NextResponse.json({ error }, { status: 400 })

  if (!body.color)          return NextResponse.json({ error: 'color required' },          { status: 400 })
  if (!body.dealershipId)   return NextResponse.json({ error: 'dealershipId required' },   { status: 400 })
  if (!body.dealershipName) return NextResponse.json({ error: 'dealershipName required' }, { status: 400 })
  if (!body.stockPrefix)    return NextResponse.json({ error: 'stockPrefix required' },    { status: 400 })

  // Verify dealership still exists
  const dealer = await getDealership(body.dealershipId)
  if (!dealer) return NextResponse.json({ error: 'Dealership not found' }, { status: 404 })

  const vin         = normalizeVIN(body.vin)
  const stockNumber = buildStockNumber(body.stockPrefix, vin)

  // VIN entries have high confidence: year/make/model from NHTSA (0.95), color/stock from employee (1.0)
  const confidence = {
    year:        body.year  && body.make ? 0.95 : 0,
    make:        body.make              ? 0.95 : 0,
    model:       body.model             ? 0.95 : 0,
    color:       1.0,
    stockNumber: 1.0,
  }

  const id = await createVehicleEntry({
    photoUrl:       'vin://no-photo',
    vin,
    entryMethod:    'vin-fallback',
    dealershipId:   dealer.id,
    dealershipName: dealer.name,
    year:           body.year,
    make:           body.make,
    model:          body.model,
    color:          body.color,
    stockNumber,
    ocrConfidence:  confidence,
  })

  logger.info(LOG, 'entry.vin.created', { id, vin, stockNumber, dealer: dealer.name })
  return NextResponse.json({ id, stockNumber }, { status: 201 })
}
