/**
 * Sticker-side print queue operations on the SHARED print_jobs table. Deliberately separate
 * from apps/checks/print-queue.ts: this file knows nothing about checks and never touches a
 * check row. Sticker jobs always carry kind 'sticker' and printer_target 'label' — the bridge
 * routes them to its configured label printer by name, NEVER a default printer.
 *
 * DUPLICATE PREVENTION: at most ONE waiting (queued/claimed) sticker job per ORDER, enforced
 * by a guarded insert AND the partial unique index print_jobs_one_waiting_sticker_per_order
 * (migration 0066) — a double-tap or two phones can never cut two stickers. Once a job is
 * submitted/failed/expired, printing again requires an explicit new request (reprint).
 */
import { getDb } from '@/platform/db'
import { sql } from 'drizzle-orm'
import type { printJobs } from '@/apps/checks/schema'
import type { StickerPrintPayload } from './render'

export type PrintJobRow = typeof printJobs.$inferSelect

/** The logical printer target for sticker jobs; the bridge maps it to its LABEL_PRINTER_NAME. */
export const LABEL_PRINTER_TARGET = 'label'
/** Sticker jobs waiting in one of these states block another enqueue for the same order. */
export const WAITING_STICKER_STATUSES = ['queued', 'claimed'] as const

function rowsOf<T>(res: unknown): T[] {
  const list = (res as { rows?: T[] }).rows ?? (res as T[])
  return Array.isArray(list) ? list : []
}
/** Raw SQL returns snake_case columns; normalise to the drizzle row shape. */
export function toJob(r: Record<string, unknown> | undefined | null): PrintJobRow | null {
  if (!r) return null
  if ('checkId' in r) return r as unknown as PrintJobRow
  const d = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)))
  return {
    id: r.id, checkId: r.check_id ?? null, kind: r.kind, status: r.status, printerTarget: r.printer_target ?? null,
    payload: r.payload, attempts: Number(r.attempts ?? 0), claimedBy: r.claimed_by ?? null, claimedAt: d(r.claimed_at),
    printedAt: d(r.printed_at), failedAt: d(r.failed_at), error: r.error ?? null, createdBy: r.created_by ?? null,
    createdAt: d(r.created_at), updatedAt: d(r.updated_at),
  } as PrintJobRow
}

/** A lost race against a concurrent enqueue (the partial unique index fired) — not an error. */
export const isStickerUniqueViolation = (e: unknown) =>
  String((e as { code?: string })?.code ?? '') === '23505' ||
  /print_jobs_one_waiting_sticker_per_order|duplicate key/i.test(String((e as Error)?.message ?? ''))

/**
 * Enqueue a sticker print job — refused (null) when the order already has a waiting job,
 * so retries and double-taps can never produce a second physical sticker.
 */
export async function enqueueStickerJob(params: {
  payload: StickerPrintPayload
  createdBy?: string | null
}): Promise<PrintJobRow | null> {
  try {
    const res = await getDb().execute(sql`
      INSERT INTO print_jobs (check_id, kind, payload, printer_target, created_by)
      SELECT NULL, 'sticker', ${JSON.stringify(params.payload)}::jsonb, ${LABEL_PRINTER_TARGET}, ${params.createdBy ?? null}
       WHERE NOT EXISTS (
         SELECT 1 FROM print_jobs
          WHERE kind = 'sticker' AND status IN ('queued', 'claimed')
            AND payload->>'orderId' = ${params.payload.orderId}
       )
      RETURNING *
    `)
    return toJob(rowsOf<Record<string, unknown>>(res)[0])
  } catch (e) {
    if (isStickerUniqueViolation(e)) return null // lost the race to a concurrent enqueue
    throw e
  }
}

/** The waiting (queued/claimed) sticker job for an order, if any. */
export async function waitingStickerJobForOrder(orderId: string): Promise<PrintJobRow | null> {
  const res = await getDb().execute(sql`
    SELECT * FROM print_jobs
     WHERE kind = 'sticker' AND status IN ('queued', 'claimed') AND payload->>'orderId' = ${orderId}
     ORDER BY created_at DESC LIMIT 1
  `)
  return toJob(rowsOf<Record<string, unknown>>(res)[0])
}

/** The most recent sticker job for an order (any status) — drives the UI status line. */
export async function latestStickerJobForOrder(orderId: string): Promise<PrintJobRow | null> {
  const res = await getDb().execute(sql`
    SELECT * FROM print_jobs
     WHERE kind = 'sticker' AND payload->>'orderId' = ${orderId}
     ORDER BY created_at DESC LIMIT 1
  `)
  return toJob(rowsOf<Record<string, unknown>>(res)[0])
}
