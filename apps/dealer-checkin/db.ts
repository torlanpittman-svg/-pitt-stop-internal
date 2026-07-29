/**
 * Dealer check-in persistence: scan records + audit events.
 */
import { eq, and, gte, desc, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { dealerScans, dealerScanEvents } from './schema'

export type DealerScanRow = typeof dealerScans.$inferSelect
export type NewDealerScan = typeof dealerScans.$inferInsert

export async function createScan(data: NewDealerScan): Promise<DealerScanRow> {
  const db = getDb()
  const [row] = await db.insert(dealerScans).values(data).returning()
  return row
}

export async function updateScan(id: string, data: Partial<NewDealerScan>): Promise<DealerScanRow | null> {
  const db = getDb()
  const [row] = await db
    .update(dealerScans)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(dealerScans.id, id))
    .returning()
  return row ?? null
}

export async function getScan(id: string): Promise<DealerScanRow | null> {
  const db = getDb()
  const [row] = await db.select().from(dealerScans).where(eq(dealerScans.id, id)).limit(1)
  return row ?? null
}

/** Recent approved scans for a stock number (duplicate detection window). */
export async function recentScansByStock(stockNumber: string, sinceDays = 7): Promise<DealerScanRow[]> {
  const db = getDb()
  const since = new Date(Date.now() - sinceDays * 86400_000)
  return db
    .select()
    .from(dealerScans)
    .where(and(
      sql`upper(${dealerScans.stockNumber}) = upper(${stockNumber})`,
      gte(dealerScans.createdAt, since),
      eq(dealerScans.status, 'approved'),
    ))
    .orderBy(desc(dealerScans.createdAt))
}

export async function logScanEvent(data: {
  scanId:    string
  eventType: string
  actor?:    string | null
  oldValue?: unknown
  newValue?: unknown
  note?:     string | null
}): Promise<void> {
  const db = getDb()
  await db.insert(dealerScanEvents).values({
    scanId:    data.scanId,
    eventType: data.eventType,
    actor:     data.actor ?? null,
    oldValue:  (data.oldValue ?? null) as never,
    newValue:  (data.newValue ?? null) as never,
    note:      data.note ?? null,
  })
}

export async function listScanEvents(scanId: string) {
  const db = getDb()
  return db
    .select()
    .from(dealerScanEvents)
    .where(eq(dealerScanEvents.scanId, scanId))
    .orderBy(dealerScanEvents.createdAt)
}

/** Scans whose QuickBooks invoice write is queued (QB was unavailable). */
export async function listQueuedScans(limit = 50): Promise<DealerScanRow[]> {
  const db = getDb()
  return db
    .select()
    .from(dealerScans)
    .where(eq(dealerScans.qbSyncStatus, 'queued'))
    .orderBy(dealerScans.createdAt)
    .limit(limit)
}

/** Delete a scan and its events (used to clean up test check-ins). */
export async function deleteScanCascade(scanId: string): Promise<void> {
  const db = getDb()
  await db.delete(dealerScanEvents).where(eq(dealerScanEvents.scanId, scanId))
  await db.delete(dealerScans).where(eq(dealerScans.id, scanId))
}
