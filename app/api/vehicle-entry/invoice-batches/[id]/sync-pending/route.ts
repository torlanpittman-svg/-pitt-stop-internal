import { NextResponse } from 'next/server'
import { getInvoiceBatch, listPendingEntriesForDealership } from '@/apps/vehicle-entry/invoice-db'
import { getDealership } from '@/apps/vehicle-entry/db'
import { syncEntryToInvoice } from '@/apps/vehicle-entry/invoice-sync'
import { logger } from '@/platform/logger'

const LOG = 'api:vehicle-entry:sync-pending'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const batch = await getInvoiceBatch(id)
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })

  if (batch.pittStopStatus !== 'active') {
    return NextResponse.json({ error: 'Only active batches can receive vehicles' }, { status: 422 })
  }

  const dealer = await getDealership(batch.dealershipId)
  if (!dealer) return NextResponse.json({ error: 'Dealership not found' }, { status: 404 })

  const pending = await listPendingEntriesForDealership(dealer.id, dealer.stockPrefix)
  logger.info(LOG, 'sync_pending.start', { batchId: id, dealer: dealer.name, count: pending.length })

  const results = await Promise.allSettled(
    pending.map(e => syncEntryToInvoice(e.id))
  )

  const summary = results.reduce(
    (acc, r) => {
      if (r.status === 'fulfilled') {
        acc[r.value.outcome] = (acc[r.value.outcome] ?? 0) + 1
      } else {
        acc.error = (acc.error ?? 0) + 1
      }
      return acc
    },
    {} as Record<string, number>
  )

  logger.info(LOG, 'sync_pending.done', { batchId: id, summary })
  return NextResponse.json({ processed: pending.length, summary })
}
