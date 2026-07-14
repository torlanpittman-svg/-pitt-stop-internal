import { NextResponse } from 'next/server'
import {
  listInvoiceBatches,
  createInvoiceBatch,
  countVehiclesInBatch,
  nextMockInvoiceNumber,
} from '@/apps/vehicle-entry/invoice-db'
import { getDealership } from '@/apps/vehicle-entry/db'
import { getQBProvider } from '@/apps/vehicle-entry/qb'
import { logger } from '@/platform/logger'

const LOG = 'api:vehicle-entry:invoice-batches'

export const dynamic = 'force-dynamic'

export async function GET() {
  const batches = await listInvoiceBatches()
  const counts  = await Promise.all(batches.map(b => countVehiclesInBatch(b.id)))
  return NextResponse.json(
    batches.map((b, i) => ({ ...b, vehicleCount: counts[i] }))
  )
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const dealershipId      = typeof body.dealershipId      === 'string' ? body.dealershipId      : null
  const quickbooksCustomerId = typeof body.quickbooksCustomerId === 'string' ? body.quickbooksCustomerId : null

  if (!dealershipId) {
    return NextResponse.json({ error: 'dealershipId is required' }, { status: 400 })
  }

  const dealer = await getDealership(dealershipId)
  if (!dealer) {
    return NextResponse.json({ error: 'Dealership not found' }, { status: 404 })
  }

  if (!quickbooksCustomerId) {
    return NextResponse.json({ error: 'quickbooksCustomerId is required' }, { status: 400 })
  }

  // Create the QB invoice via the provider
  const invoiceNumber = await nextMockInvoiceNumber()
  const qb = getQBProvider()
  const qbResult = await qb.createInvoice({
    customerId:   quickbooksCustomerId,
    customerName: dealer.name,
    invoiceNumber,
  })

  const batchId = await createInvoiceBatch({
    dealershipId,
    dealershipName:          dealer.name,
    quickbooksCustomerId,
    quickbooksInvoiceId:     qbResult.invoiceId,
    quickbooksInvoiceNumber: qbResult.invoiceNumber,
    pittStopStatus:          'draft',
  })

  logger.info(LOG, 'batch.created', { batchId, dealer: dealer.name, invoiceNumber })
  return NextResponse.json({ id: batchId, invoiceNumber, invoiceId: qbResult.invoiceId }, { status: 201 })
}
