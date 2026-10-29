/**
 * Parts screenshot import — collection route.
 *   GET  → job context (incl. VIN for "Copy VIN"), the feature flag, and this order's imports.
 *   POST → multipart upload of 1–4 PartsTech screenshots: bounded body read → validate EVERY screenshot
 *          (magic bytes + real raster decode + aggregate size) → preserve the ORIGINALS privately → create
 *          the batch (atomic, DB-idempotent) → return a FAST durable acknowledgement. The AI read runs as a
 *          SEPARATE action the uploader triggers afterward, so a slow/failed read can never make the upload
 *          "feel lost" or blow the function time budget.
 *
 * Gating (defense-in-depth; proxy.ts is the primary gate): a VALID shop session AND partsVisibleFor() AND
 * the PARTS_SCREENSHOT_IMPORT_ENABLED flag. EQUAL PERMISSIONS: every authorized shop user has the SAME import
 * capability (upload, read, see costs + originals, review, save, cancel) — no manager handoff. NEVER bills,
 * never QB.
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { validateReceiptUpload, extForMime, MAX_UPLOAD_BYTES, MAX_DECLARED_OVERHEAD } from '@/apps/expenses/upload-validation'
import { decodeImageMeta, validateDecodedMeta } from '@/apps/expenses/image-decode'
import { consumeRateLimit, RATE_LIMITS } from '@/apps/expenses/db'
import { MAX_IMPORT_IMAGES } from '@/apps/parts/import-normalize'
import { assertDecodable } from '@/apps/parts/import-image'
import { importStorageKey, storeImportImageBytes } from '@/apps/parts/import-storage'
import { getImportJobContext, createBatchWithImages, listBatchesForOrder, type NewImage } from '@/apps/parts/import-db'
import { errorCode } from '@/apps/expenses/errors'
import { logger } from '@/platform/logger'
import { importGate, isUuid, sameOrigin } from './_gate'
import { readBoundedBody } from './_body'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const APP = 'parts:import'
const BODY_CAP = MAX_UPLOAD_BYTES + MAX_DECLARED_OVERHEAD

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await importGate(req)
  if ('response' in g) return g.response
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'Bad job id.' }, { status: 400 })
  const job = await getImportJobContext(id)
  if (!job) return NextResponse.json({ ok: false, error: 'Job not found.' }, { status: 404 })
  const batches = await listBatchesForOrder(id)
  return NextResponse.json({ ok: true, enabled: true, canReview: true, job, batches })
}

/** Read the bounded body (HARD byte cap via the shared reader) then parse the multipart form. */
async function boundedFormData(req: Request, cap: number): Promise<FormData> {
  const buf = await readBoundedBody(req, cap)
  if (buf === null) return req.formData()
  return new Request(req.url, { method: 'POST', headers: req.headers, body: new Uint8Array(buf) }).formData()
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await importGate(req)
  if ('response' in g) return g.response
  if (!sameOrigin(req)) return NextResponse.json({ ok: false, error: 'Bad request origin.' }, { status: 403 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'Bad job id.' }, { status: 400 })
  const job = await getImportJobContext(id)
  if (!job) return NextResponse.json({ ok: false, error: 'Job not found.' }, { status: 404 })

  // Durable rate limit (reuses the shared counter; bucketed by verified actor, else shared device by IP).
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const bucket = g.actorKey ? `parts-import:actor:${g.actorKey}` : `parts-import:shared:${createHash('sha256').update(ip).digest('hex').slice(0, 16)}`
  const rl = await consumeRateLimit(bucket, RATE_LIMITS.upload.limit, RATE_LIMITS.upload.windowMs)
  if (!rl.ok) return NextResponse.json({ ok: false, error: `Too many uploads — try again in ${rl.retryAfterSec}s.` }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec ?? 60) } })

  let form: FormData
  try { form = await boundedFormData(req, BODY_CAP) }
  catch (err) {
    if (err instanceof RangeError) return NextResponse.json({ ok: false, error: 'Upload too large — the app shrinks screenshots before upload; try fewer or smaller images.' }, { status: 413 })
    return NextResponse.json({ ok: false, error: 'Could not read the upload.' }, { status: 400 })
  }

  // captureId must be TEXT (a UUID), never an uploaded file.
  const rawCapture = form.get('captureId')
  if (rawCapture != null && typeof rawCapture !== 'string') return NextResponse.json({ ok: false, error: 'Bad capture id.' }, { status: 400 })
  const captureStr = typeof rawCapture === 'string' ? rawCapture.trim() : ''
  if (captureStr && !isUuid(captureStr)) return NextResponse.json({ ok: false, error: 'Bad capture id.' }, { status: 400 })
  const captureId = captureStr || null
  // Every 'screenshots' member must be a File — a malformed/text member is rejected, never silently dropped.
  const rawShots = form.getAll('screenshots')
  if (rawShots.some((s) => !(s instanceof File))) return NextResponse.json({ ok: false, error: 'Bad screenshot upload.' }, { status: 400 })
  const files = rawShots as File[]
  if (files.length === 0) return NextResponse.json({ ok: false, error: 'Add at least one screenshot.' }, { status: 400 })
  if (files.length > MAX_IMPORT_IMAGES) return NextResponse.json({ ok: false, error: `Up to ${MAX_IMPORT_IMAGES} screenshots per import.` }, { status: 400 })

  // PASS 1 — validate EVERY screenshot (magic bytes + real raster decode + aggregate size) BEFORE storing any,
  // so we never persist some blobs and then reject the last bad image.
  const validated: Array<{ bytes: Buffer; mime: 'image/jpeg' | 'image/png' | 'image/webp'; imageHash: string }> = []
  let totalBytes = 0
  for (const file of files) {
    const bytes = Buffer.from(await file.arrayBuffer())
    totalBytes += bytes.length
    if (totalBytes > MAX_UPLOAD_BYTES) return NextResponse.json({ ok: false, error: 'Upload too large — shrink or send fewer screenshots.' }, { status: 413 })
    const v = validateReceiptUpload(file.type, bytes.length, bytes.subarray(0, 16))
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: v.status })
    if (!validateDecodedMeta(await decodeImageMeta(bytes)).ok || !(await assertDecodable(bytes))) {
      return NextResponse.json({ ok: false, error: 'That screenshot could not be read as a valid image — retake it.' }, { status: 415 })
    }
    validated.push({ bytes, mime: v.mime, imageHash: createHash('sha256').update(bytes).digest('hex') })
  }

  // PASS 2 — preserve each ORIGINAL privately. A storage failure HARD-FAILS (never a phantom "saved").
  const stored: NewImage[] = []
  for (const im of validated) {
    try {
      const storageRef = await storeImportImageBytes(importStorageKey(id, im.imageHash, extForMime(im.mime)), im.bytes, im.mime)
      stored.push({ imageHash: im.imageHash, storageRef, contentType: im.mime, byteSize: im.bytes.length })
    } catch (err) {
      logger.error(APP, 'storage_failed', { code: errorCode(err) })
      return NextResponse.json({ ok: false, error: 'Could not save the screenshot — check your connection and try again.' }, { status: 502 })
    }
  }

  // Create (or resume) the batch — DB-idempotent on capture_id + batch_hash; atomic batch+images.
  const result = await createBatchWithImages({ orderId: id, captureId, images: stored, uploadedBy: g.actorName, uploadedByKey: g.actorKey })
  if (result.conflict) {
    return NextResponse.json({ ok: false, error: 'A different set of screenshots was already saved for this upload — reload the import and try again.', batchId: result.batchId }, { status: 409 })
  }
  logger.info(APP, 'saved', { duplicate: result.duplicate, images: stored.length })
  // FAST durable ack — the screenshots are saved. The client triggers the read next (POST …/[batchId] read).
  return NextResponse.json({ ok: true, batchId: result.batchId, duplicate: result.duplicate, saved: true })
}
