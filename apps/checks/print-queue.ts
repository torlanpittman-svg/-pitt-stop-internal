/**
 * Cloud print QUEUE operations. The bridge is a dumb, authenticated poller: it CLAIMS the next queued
 * job (atomic, skip-locked so multiple bridges never grab the same one), prints the PDF, then REPORTS
 * the outcome — which also updates the underlying check's print_status/reprintCount + audit (via the
 * service). Nothing here mutates QuickBooks.
 */
import { getDb } from '@/platform/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { printJobs } from './schema'
import type { CheckPrintPayload } from './render'

export type PrintJobRow = typeof printJobs.$inferSelect

export async function enqueuePrintJob(params: {
  checkId: string
  kind?: 'check' | 'reprint'
  payload: CheckPrintPayload
  printerTarget?: string | null
  createdBy?: string | null
}): Promise<PrintJobRow> {
  const [row] = await getDb().insert(printJobs).values({
    checkId: params.checkId,
    kind: params.kind ?? 'check',
    payload: params.payload,
    printerTarget: params.printerTarget ?? null,
    createdBy: params.createdBy ?? null,
  }).returning()
  return row
}

/**
 * Atomically claim the oldest queued job for a bridge. Single statement with FOR UPDATE SKIP LOCKED so
 * concurrent bridges never double-print. Returns the claimed row or null when the queue is empty.
 */
export async function claimNextJob(bridgeId: string): Promise<PrintJobRow | null> {
  const rows = await getDb().execute(sql`
    UPDATE print_jobs
       SET status = 'claimed', claimed_by = ${bridgeId}, claimed_at = now(),
           attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM print_jobs WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING *
  `)
  const list = (rows as unknown as { rows?: PrintJobRow[] }).rows ?? (rows as unknown as PrintJobRow[])
  return (Array.isArray(list) ? list[0] : null) ?? null
}

export async function getJob(id: string): Promise<PrintJobRow | null> {
  const [row] = await getDb().select().from(printJobs).where(eq(printJobs.id, id)).limit(1)
  return row ?? null
}

export async function markJobPrinted(id: string): Promise<PrintJobRow | null> {
  const [row] = await getDb().update(printJobs).set({ status: 'printed', printedAt: new Date(), error: null, updatedAt: new Date() }).where(eq(printJobs.id, id)).returning()
  return row ?? null
}

export async function markJobFailed(id: string, error: string): Promise<PrintJobRow | null> {
  const [row] = await getDb().update(printJobs).set({ status: 'failed', failedAt: new Date(), error: error.slice(0, 2000), updatedAt: new Date() }).where(eq(printJobs.id, id)).returning()
  return row ?? null
}

/** Re-queue a failed/claimed job so it prints again (same check, same number). */
export async function requeueJob(id: string): Promise<PrintJobRow | null> {
  const [row] = await getDb().update(printJobs).set({ status: 'queued', claimedBy: null, claimedAt: null, error: null, updatedAt: new Date() }).where(eq(printJobs.id, id)).returning()
  return row ?? null
}

export async function jobsForCheck(checkId: string): Promise<PrintJobRow[]> {
  return getDb().select().from(printJobs).where(eq(printJobs.checkId, checkId)).orderBy(desc(printJobs.createdAt))
}

/** Recently active jobs (for a bridge/ops view). */
export async function recentJobs(limit = 25): Promise<PrintJobRow[]> {
  return getDb().select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(limit)
}

export async function queuedCount(): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)` }).from(printJobs).where(eq(printJobs.status, 'queued'))
  return Number(row?.n ?? 0)
}
