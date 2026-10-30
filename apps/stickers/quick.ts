/**
 * QUICK oil-change sticker printing — the homepage entry, used when a car gets an oil change
 * without anybody opening (or creating) a job for it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It creates NO service order, customer, vehicle, or oil_change_stickers row. There is no job
 *     behind a quick sticker, so inventing one would put fiction into the Work Board and into the
 *     per-vehicle sticker history. The queue payload is the only record, and it says so explicitly
 *     (`quick.source = 'quick'`, the request token, who asked, and the values printed).
 *   - It touches nothing financial: no QuickBooks, no checks, no bank data. Same guarantees as the
 *     job sticker (see ./service.ts).
 *
 * IDEMPOTENCY — the one thing that must not be sloppy, because the output is physical paper:
 *   The client mints a request token (UUID) BEFORE the first attempt and keeps it across retries.
 *   That token IS the print_jobs primary key, so "has this request already been accepted?" is
 *   answered by Postgres, permanently — including after the job is submitted, failed, or expired.
 *   A retry therefore reports the ORIGINAL outcome instead of printing again. A second sticker is
 *   only ever possible through a new, deliberate request with a new token.
 *
 * OWNERSHIP: the token comes from the client, so finding a row proves nothing. Every read and
 * every repeat accept verifies the job is a quick sticker AND belongs to the signed-in actor;
 * anything else answers "not found" (never "that's someone else's print").
 */
import { expireStaleJobs } from '@/apps/checks/print-queue'
import { enqueueQuickStickerJob, printJobById, type PrintJobRow } from './queue'
import { buildStickerPayload, type StickerQuickMeta } from './render'
import { businessToday, formatMiles, formatStickerDate } from './calc'
import {
  DEFAULT_INTERVAL_MILES, DEFAULT_INTERVAL_MONTHS, STICKER_KINDS,
  StickerValidationError, jobView, labelBridgeStatus, validateStickerInput,
  type LabelBridgeStatus, type StickerJobView, type StickerPrintInput,
} from './service'
import { logger } from '@/platform/logger'

/** Namespace for every identifier a quick sticker puts in the shared queue. A quick sticker is
 *  never given a fabricated UUID: anything reading the payload can tell at a glance that there is
 *  no order behind it, and order-scoped lookups (which pass real UUIDs) can never match it. */
export const QUICK_REF_PREFIX = 'quick:'
export const quickStickerRef = (requestId: string) => `${QUICK_REF_PREFIX}${requestId}`

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface QuickActor { key: string; name: string | null }

export interface QuickStickerInput extends StickerPrintInput {
  /** Client-minted idempotency token; becomes the print_jobs primary key. */
  requestId: string
}

export interface QuickStickerResult {
  requestId: string
  job: StickerJobView
  /** true = this exact request had already been accepted; nothing new was printed. */
  alreadyQueued: boolean
}

export interface QuickStickerBootstrap {
  /** Who the server says is signed in — the client namespaces its saved pending request on this,
   *  so a different person on the same device never inherits someone else's in-flight sticker. */
  actorKey: string
  actorName: string | null
  defaults: { intervalMiles: number; intervalMonths: number }
  today: string
  bridge: LabelBridgeStatus
}

/** Not a UUID → refuse before any SQL (the value is cast to uuid in the queue statements). */
function validateRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
    throw new StickerValidationError('This print request is missing its identifier — reopen the sticker form and try again.', 'bad_request_id')
  }
  return requestId.toLowerCase()
}

/** The quick-sticker provenance on a job, or null when the job is not a quick sticker at all. */
function quickMetaOf(job: PrintJobRow | null): StickerQuickMeta | null {
  if (!job || job.kind !== 'sticker') return null
  const meta = (job.payload as { quick?: StickerQuickMeta } | null)?.quick
  return meta && meta.source === 'quick' && typeof meta.actorKey === 'string' ? meta : null
}

/**
 * The job for `requestId` IF it is a quick sticker belonging to `actor`. Everything else —
 * no such job, a check job, an order's sticker job, or another person's quick sticker — is
 * reported identically as "not found", so no one can probe the queue with guessed ids.
 */
async function ownedQuickJob(requestId: string, actor: QuickActor): Promise<{ job: PrintJobRow; meta: StickerQuickMeta } | null> {
  const job = await printJobById(requestId)
  const meta = quickMetaOf(job)
  if (!job || !meta || meta.actorKey !== actor.key) return null
  return { job, meta }
}

/** Everything the quick sticker form needs to open: interval prefills, today, printer link, identity. */
export async function quickStickerBootstrap(actor: QuickActor): Promise<QuickStickerBootstrap> {
  return {
    actorKey: actor.key,
    actorName: actor.name,
    defaults: { intervalMiles: DEFAULT_INTERVAL_MILES, intervalMonths: DEFAULT_INTERVAL_MONTHS },
    today: businessToday(),
    bridge: await labelBridgeStatus(),
  }
}

/**
 * Accept a quick sticker request and queue it to the shop label printer.
 *
 * Validation runs BEFORE anything is written, so a rejected request consumes nothing and the same
 * token may be reused once the values are fixed. After the request is accepted the token is spent:
 * re-sending it returns the original job (`alreadyQueued`), never a second print — even if the
 * values in the body changed, and even after the job reached a terminal status.
 */
export async function queueQuickStickerPrint(input: QuickStickerInput, actor: QuickActor): Promise<QuickStickerResult> {
  const requestId = validateRequestId(input.requestId)

  // A spent token is the common case for a retry, so answer it without re-validating the body.
  const owned = await ownedQuickJob(requestId, actor)
  if (owned) {
    await expireStaleJobs(STICKER_KINDS).catch(() => {})
    const fresh = await printJobById(requestId)
    return { requestId, job: jobView(fresh ?? owned.job), alreadyQueued: true }
  }

  const v = validateStickerInput(input)
  const nextDateText = formatStickerDate(v.nextDate)!
  const nextMileageText = formatMiles(v.nextMileage)
  const ref = quickStickerRef(requestId)
  const quick: StickerQuickMeta = {
    source: 'quick', requestId, actorKey: actor.key, actorName: actor.name,
    mileage: v.mileage, intervalMiles: v.intervalMiles, intervalMonths: v.intervalMonths,
    nextMileage: v.nextMileage, nextDate: v.nextDate, nextDateText, nextMileageText,
  }
  // Same positioned layout the job sticker and the preview use — one design, one calculation.
  const payload = buildStickerPayload({ stickerId: ref, orderId: ref, values: { nextDateText, nextMileageText }, quick })

  await expireStaleJobs(STICKER_KINDS).catch(() => {}) // only sticker kinds: checks reconcile their own
  const { job, created } = await enqueueQuickStickerJob({ requestId, payload, createdBy: actor.name })
  if (!job) throw new StickerValidationError('Could not queue the sticker — try again.', 'enqueue_failed')

  if (!created) {
    // Lost the race to a concurrent attempt with the same token (two taps, two tabs). The winner's
    // row is the answer — but only if it really is this actor's quick sticker.
    if (!quickMetaOf(job) || quickMetaOf(job)!.actorKey !== actor.key) {
      throw new StickerValidationError('This print request could not be used — reopen the sticker form and try again.', 'request_id_conflict')
    }
    return { requestId, job: jobView(job), alreadyQueued: true }
  }
  logger.info('stickers', 'quick.queued', { requestId, jobId: job.id, by: actor.name })
  return { requestId, job: jobView(job), alreadyQueued: false }
}

/** Current status of a quick sticker request (for polling), with sticker-only expiry reflected first. */
export async function quickStickerJobStatus(requestId: unknown, actor: QuickActor): Promise<StickerJobView> {
  const id = validateRequestId(requestId)
  await expireStaleJobs(STICKER_KINDS).catch(() => {})
  const owned = await ownedQuickJob(id, actor)
  if (!owned) throw new StickerValidationError('Print job not found.', 'job_not_found')
  return jobView(owned.job)
}
