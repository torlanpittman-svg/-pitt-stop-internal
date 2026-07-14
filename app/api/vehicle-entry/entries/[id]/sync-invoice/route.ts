import { NextResponse } from 'next/server'
import { syncEntryToInvoice } from '@/apps/vehicle-entry/invoice-sync'
import { logger } from '@/platform/logger'

const LOG = 'api:vehicle-entry:sync-invoice'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const outcome = await syncEntryToInvoice(id)
    logger.info(LOG, 'sync.done', { id, outcome: outcome.outcome })
    return NextResponse.json(outcome)
  } catch (err) {
    logger.error(LOG, 'sync.error', { id, error: String(err) })
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
