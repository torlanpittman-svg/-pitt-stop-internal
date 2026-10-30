/**
 * Oil-change sticker service — validation, the durable sticker record, queueing to the shop
 * label printer, and job status for the UI.
 *
 * INDEPENDENCE GUARANTEES (the invariants that matter here):
 *   - Nothing in this module touches QuickBooks, check records, bank data, or job completion.
 *     A sticker that fails to print can never block finishing a job.
 *   - A sticker job is claimed only by a bridge that declares a configured label printer
 *     (see /api/print-bridge/claim) and is always routed to that printer BY NAME.
 *   - Queued jobs expire after PRINT_JOB_TTL_MINUTES (shared queue rule), so a stale sticker
 *     never pops out of the printer when the shop computer reconnects hours later.
 *   - Reprints are explicit: once a job reaches submitted/failed/expired, printing again
 *     requires a new deliberate request.
 */
import { getDb } from '@/platform/db'
import { desc, eq } from 'drizzle-orm'
import { serviceOrders, vehicles } from '@/apps/workflow/schema'
import { oilChangeStickers } from './schema'
import {
  expireStaleJobs, transitionJob, getJob, getBridgeStatus,
  PRINT_JOB_TTL_MINUTES, CLAIM_UNCERTAIN_AFTER_SECONDS,
} from '@/apps/checks/print-queue'
import { enqueueStickerJob, waitingStickerJobForOrder, latestStickerJobForOrder, type PrintJobRow } from './queue'
import { buildStickerPayload, isStickerPayload, type StickerPrintPayload } from './render'
import { renderStickerPdf } from './pdf'
import { businessToday, computeNextService, formatStickerDate, formatMiles } from './calc'
import { logger } from '@/platform/logger'

export { PRINT_JOB_TTL_MINUTES }

/**
 * Expiry sweeps started from THIS module only ever expire sticker jobs. The queue is shared, and
 * expiring a job consumes it: if a sticker code path swept a stale CHECK job, apps/checks could no
 * longer reflect that outcome on the check (print_failed + the 'print_expired' event would be lost).
 * Checks reconcile their own queue (reconcileExpiredJobs), so nothing here needs to touch them.
 */
export const STICKER_KINDS = ['sticker'] as const

export class StickerValidationError extends Error {
  code: string
  constructor(message: string, code: string) { super(message); this.code = code }
}

export type StickerRow = typeof oilChangeStickers.$inferSelect

/** Default interval PREFILL (owner-chosen 2026-10-30). A prefill only — every sticker's
 * interval is editable in the form; nothing assumes one interval fits every vehicle. */
export const DEFAULT_INTERVAL_MILES = 5000
export const DEFAULT_INTERVAL_MONTHS = 6

export interface StickerPrintInput {
  mileage: number
  intervalMiles: number | null
  intervalMonths: number | null
  /** Manual overrides of the computed values (optional). */
  nextMileage?: number | null
  nextDate?: string | null // YYYY-MM-DD
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

export interface ValidatedStickerInput { mileage: number; intervalMiles: number | null; intervalMonths: number | null; nextMileage: number; nextDate: string }

/**
 * THE sticker validation — shared by the job sticker and the homepage quick sticker so the two
 * entry points can never drift apart on what is printable. Pure except for `businessToday()`.
 */
export function validateStickerInput(input: StickerPrintInput): ValidatedStickerInput {
  if (!isInt(input.mileage) || input.mileage < 0 || input.mileage > 2_000_000) {
    throw new StickerValidationError('Enter the vehicle’s current mileage (whole number).', 'bad_mileage')
  }
  const intervalMiles = input.intervalMiles ?? null
  const intervalMonths = input.intervalMonths ?? null
  if (intervalMiles !== null && (!isInt(intervalMiles) || intervalMiles < 500 || intervalMiles > 100_000)) {
    throw new StickerValidationError('The mileage interval must be between 500 and 100,000 miles.', 'bad_interval_miles')
  }
  if (intervalMonths !== null && (!isInt(intervalMonths) || intervalMonths < 1 || intervalMonths > 60)) {
    throw new StickerValidationError('The month interval must be between 1 and 60 months.', 'bad_interval_months')
  }
  const computed = computeNextService({ mileage: input.mileage, intervalMiles, intervalMonths })
  const nextMileage = input.nextMileage ?? computed.nextMileage
  const nextDate = input.nextDate ?? computed.nextDate
  if (!isInt(nextMileage) || nextMileage <= input.mileage || nextMileage > 3_000_000) {
    throw new StickerValidationError('The next-service mileage must be greater than the current mileage.', 'bad_next_mileage')
  }
  if (!nextDate || !formatStickerDate(nextDate)) {
    throw new StickerValidationError('Pick a valid next-service date.', 'bad_next_date')
  }
  const today = businessToday()
  const limit = `${parseInt(today.slice(0, 4), 10) + 6}${today.slice(4)}`
  if (nextDate < today || nextDate > limit) {
    throw new StickerValidationError('The next-service date must be in the future (within 6 years).', 'bad_next_date')
  }
  return { mileage: input.mileage, intervalMiles, intervalMonths, nextMileage, nextDate }
}

export interface StickerJobView {
  jobId: string
  status: string            // queued | claimed | submitted | failed | expired | canceled
  error: string | null
  uncertain: boolean        // claimed with no report for too long — a person should look
  createdAt: string
}

/** The honest, UI-facing view of a print job (shared with the quick-print path). */
export function jobView(job: PrintJobRow, now: Date = new Date()): StickerJobView {
  const uncertain = job.status === 'claimed' && !!job.claimedAt
    && now.getTime() - new Date(job.claimedAt).getTime() > CLAIM_UNCERTAIN_AFTER_SECONDS * 1000
  return {
    jobId: job.id, status: job.status, error: job.error ?? null, uncertain,
    createdAt: new Date(job.createdAt).toISOString(),
  }
}

export interface LabelBridgeStatus { online: boolean; labelPrinterConfigured: boolean }

/** Is a bridge online, and does any online bridge have a label printer configured? */
export async function labelBridgeStatus(): Promise<LabelBridgeStatus> {
  const status = await getBridgeStatus()
  const online = status.bridges.filter((b) => b.online)
  return { online: online.length > 0, labelPrinterConfigured: online.some((b) => b.labelPrinter) }
}

export interface StickerPrefill {
  vehicle: { year: string | null; make: string | null; model: string | null; color: string | null; licensePlate: string | null } | null
  lastSticker: { mileage: number; intervalMiles: number | null; intervalMonths: number | null; createdAt: string } | null
  defaults: { intervalMiles: number; intervalMonths: number }
  today: string
  bridge: LabelBridgeStatus
  activeJob: StickerJobView | null
  lastJob: StickerJobView | null
}

/** Everything the sticker form needs to open prefilled. */
export async function stickerPrefill(orderId: string): Promise<StickerPrefill> {
  const db = getDb()
  const [order] = await db.select({ id: serviceOrders.id, vehicleId: serviceOrders.vehicleId }).from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  if (!order) throw new StickerValidationError('Job not found.', 'not_found')
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, order.vehicleId)).limit(1)
  const [last] = vehicle
    ? await db.select().from(oilChangeStickers).where(eq(oilChangeStickers.vehicleId, vehicle.id)).orderBy(desc(oilChangeStickers.createdAt)).limit(1)
    : []
  await expireStaleJobs(STICKER_KINDS).catch(() => {}) // reflect expiry before reporting a stale "queued"
  const active = await waitingStickerJobForOrder(orderId)
  const latest = active ?? await latestStickerJobForOrder(orderId)
  return {
    vehicle: vehicle ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, color: vehicle.color, licensePlate: vehicle.licensePlate } : null,
    lastSticker: last ? { mileage: last.mileage, intervalMiles: last.intervalMiles, intervalMonths: last.intervalMonths, createdAt: last.createdAt.toISOString() } : null,
    defaults: { intervalMiles: DEFAULT_INTERVAL_MILES, intervalMonths: DEFAULT_INTERVAL_MONTHS },
    today: businessToday(),
    bridge: await labelBridgeStatus(),
    activeJob: active ? jobView(active) : null,
    lastJob: latest ? jobView(latest) : null,
  }
}

export interface QueueStickerResult { stickerId: string; job: StickerJobView; alreadyQueued: boolean }

/**
 * Record a sticker and queue it to the shop label printer. Idempotent against double-taps:
 * if the order already has a waiting job, THAT job is returned (no second sticker row, no
 * second print). Never touches the order's status, QuickBooks, or anything financial.
 */
export async function queueStickerPrint(orderId: string, input: StickerPrintInput, actor: { name: string | null }): Promise<QueueStickerResult> {
  const v = validateStickerInput(input)
  const db = getDb()
  const [order] = await db.select({ id: serviceOrders.id, vehicleId: serviceOrders.vehicleId, status: serviceOrders.status }).from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  if (!order) throw new StickerValidationError('Job not found.', 'not_found')
  if (order.status === 'cancelled') throw new StickerValidationError('This job was cancelled — no sticker can be printed for it.', 'order_cancelled')

  await expireStaleJobs(STICKER_KINDS).catch(() => {})
  const existing = await waitingStickerJobForOrder(orderId)
  if (existing) {
    const payload = existing.payload as unknown as StickerPrintPayload
    return { stickerId: payload.stickerId ?? '', job: jobView(existing), alreadyQueued: true }
  }

  const nextDateText = formatStickerDate(v.nextDate)!
  const [row] = await db.insert(oilChangeStickers).values({
    orderId, vehicleId: order.vehicleId,
    mileage: v.mileage, intervalMiles: v.intervalMiles, intervalMonths: v.intervalMonths,
    nextMileage: v.nextMileage, nextDate: v.nextDate, nextDateText,
    createdBy: actor.name,
  }).returning()

  const payload = buildStickerPayload({
    stickerId: row.id, orderId,
    values: { nextDateText, nextMileageText: formatMiles(v.nextMileage) },
  })
  const job = await enqueueStickerJob({ payload, createdBy: actor.name })
  if (!job) {
    // Lost the race to a concurrent tap — return the winner's job.
    const winner = await waitingStickerJobForOrder(orderId)
    if (winner) {
      const p = winner.payload as unknown as StickerPrintPayload
      return { stickerId: p.stickerId ?? row.id, job: jobView(winner), alreadyQueued: true }
    }
    throw new StickerValidationError('Could not queue the sticker — try again.', 'enqueue_failed')
  }
  logger.info('stickers', 'print.queued', { orderId, stickerId: row.id, jobId: job.id, by: actor.name })
  return { stickerId: row.id, job: jobView(job), alreadyQueued: false }
}

/**
 * Explicit reprint of an existing sticker (same values, new print job). Refused while a
 * waiting job exists for the order — never a silent duplicate.
 */
export async function reprintSticker(orderId: string, stickerId: string, actor: { name: string | null }): Promise<QueueStickerResult> {
  const db = getDb()
  const [row] = await db.select().from(oilChangeStickers).where(eq(oilChangeStickers.id, stickerId)).limit(1)
  if (!row || row.orderId !== orderId) throw new StickerValidationError('Sticker not found for this job.', 'not_found')
  await expireStaleJobs(STICKER_KINDS).catch(() => {})
  const existing = await waitingStickerJobForOrder(orderId)
  if (existing) return { stickerId, job: jobView(existing), alreadyQueued: true }
  const payload = buildStickerPayload({
    stickerId: row.id, orderId,
    values: { nextDateText: row.nextDateText, nextMileageText: formatMiles(row.nextMileage) },
  })
  const job = await enqueueStickerJob({ payload, createdBy: actor.name })
  if (!job) {
    const winner = await waitingStickerJobForOrder(orderId)
    if (winner) return { stickerId, job: jobView(winner), alreadyQueued: true }
    throw new StickerValidationError('Could not queue the reprint — try again.', 'enqueue_failed')
  }
  logger.info('stickers', 'reprint.queued', { orderId, stickerId, jobId: job.id, by: actor.name })
  return { stickerId, job: jobView(job), alreadyQueued: false }
}

/** Current status of a sticker print job (for polling), with expiry reflected first. */
export async function stickerJobStatus(orderId: string, jobId: string): Promise<StickerJobView> {
  await expireStaleJobs(STICKER_KINDS).catch(() => {})
  const job = await getJob(jobId)
  if (!job || job.kind !== 'sticker') throw new StickerValidationError('Print job not found.', 'job_not_found')
  const payload = job.payload as unknown as StickerPrintPayload
  if (payload?.orderId !== orderId) throw new StickerValidationError('Print job not found for this job.', 'job_not_found')
  return jobView(job)
}

/**
 * Turn a just-claimed sticker job into the PDF the bridge prints — or refuse (job fails,
 * nothing is sent). Called from the claim route for kind 'sticker' only.
 */
export async function renderStickerJob(job: PrintJobRow): Promise<{ pdf: Buffer } | { refused: string }> {
  const refuse = async (reason: string) => {
    await transitionJob(job.id, ['claimed'], 'failed', reason)
    logger.warn('stickers', 'print.refused', { jobId: job.id, reason })
    return { refused: reason }
  }
  try {
    const payload = job.payload as unknown
    if (!isStickerPayload(payload)) return refuse('sticker payload is malformed — not printed')
    return { pdf: renderStickerPdf(payload) }
  } catch (e) {
    return refuse(`render_failed: ${String((e as Error)?.message ?? e)}`)
  }
}
