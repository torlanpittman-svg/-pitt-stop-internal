import { NextResponse } from 'next/server'
import { getDb } from '@/platform/db'
import { vehicleEntries, mockQbInvoices, invoiceBatches } from '@/apps/vehicle-entry/schema'
import { eq, and } from 'drizzle-orm'
import { logger } from '@/platform/logger'

export const dynamic = 'force-dynamic'

const LOG = 'api:vehicle-entry:pilot-reset'

export async function POST() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  const db = getDb()

  // 1. Count and delete pilot vehicle entries
  const pilotEntries = await db
    .select({ id: vehicleEntries.id })
    .from(vehicleEntries)
    .where(eq(vehicleEntries.isPilotEntry, true))

  if (pilotEntries.length > 0) {
    await db.delete(vehicleEntries).where(eq(vehicleEntries.isPilotEntry, true))
  }

  // 2. Find all mock QB invoices linked to active batches, reset their lines
  const activeBatches = await db
    .select({ quickbooksInvoiceId: invoiceBatches.quickbooksInvoiceId })
    .from(invoiceBatches)
    .where(eq(invoiceBatches.pittStopStatus, 'active'))

  for (const batch of activeBatches) {
    if (batch.quickbooksInvoiceId) {
      await db
        .update(mockQbInvoices)
        .set({ lines: [], syncToken: 1, updatedAt: new Date() })
        .where(eq(mockQbInvoices.id, batch.quickbooksInvoiceId))
    }
  }

  logger.info(LOG, 'pilot.reset', {
    deletedEntries:    pilotEntries.length,
    clearedInvoices:   activeBatches.filter(b => b.quickbooksInvoiceId).length,
  })

  return NextResponse.json({
    deleted:        pilotEntries.length,
    invoicesCleared: activeBatches.filter(b => b.quickbooksInvoiceId).length,
    message:        `Deleted ${pilotEntries.length} pilot entries and cleared ${activeBatches.filter(b => b.quickbooksInvoiceId).length} mock invoices.`,
  })
}
