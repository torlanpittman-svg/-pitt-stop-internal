import { NextResponse } from 'next/server'
import {
  getInvoiceBatch,
  updateInvoiceBatch,
  countVehiclesInBatch,
  listInvoiceBatches,
} from '@/apps/vehicle-entry/invoice-db'
import { logger } from '@/platform/logger'
import type { PittStopBatchStatus } from '@/apps/vehicle-entry/invoice-db'

const LOG = 'api:vehicle-entry:invoice-batches:id'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const batch = await getInvoiceBatch(id)
  if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const vehicleCount = await countVehiclesInBatch(id)
  return NextResponse.json({ ...batch, vehicleCount })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const batch = await getInvoiceBatch(id)
  if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const newStatus = typeof body.pittStopStatus === 'string'
    ? body.pittStopStatus as PittStopBatchStatus
    : null

  if (!newStatus) {
    return NextResponse.json({ error: 'pittStopStatus is required' }, { status: 400 })
  }

  const ALLOWED_TRANSITIONS: Record<PittStopBatchStatus, PittStopBatchStatus[]> = {
    draft:      ['active', 'cancelled'],
    active:     ['finalized', 'cancelled'],
    finalized:  ['closed'],
    closed:     [],
    cancelled:  [],
  }

  if (!ALLOWED_TRANSITIONS[batch.pittStopStatus]?.includes(newStatus)) {
    return NextResponse.json(
      { error: `Cannot transition from ${batch.pittStopStatus} to ${newStatus}` },
      { status: 422 }
    )
  }

  // Only one active batch per dealership
  if (newStatus === 'active') {
    const all = await listInvoiceBatches()
    const existingActive = all.find(
      b => b.dealershipId === batch.dealershipId && b.pittStopStatus === 'active' && b.id !== id
    )
    if (existingActive) {
      return NextResponse.json(
        { error: `${batch.dealershipName} already has an active batch (#${existingActive.quickbooksInvoiceNumber})` },
        { status: 409 }
      )
    }
  }

  const updates: Parameters<typeof updateInvoiceBatch>[1] = { pittStopStatus: newStatus }
  if (newStatus === 'finalized') updates.finalizedDate = new Date()
  if (newStatus === 'closed')    updates.closedDate    = new Date()

  const updated = await updateInvoiceBatch(id, updates)
  logger.info(LOG, 'batch.status_changed', { id, from: batch.pittStopStatus, to: newStatus })
  return NextResponse.json(updated)
}
