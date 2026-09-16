/**
 * POST /api/expenses/receipt  (multipart: receipt)
 *
 * General business-expense receipt capture (Detail AND Auto Sales). Employee-safe surface, but FAIL-CLOSED:
 * it requires a SERVER-VERIFIED session (receiptUploaderFromRequest) — an anonymous caller is rejected even
 * when no PIN is configured. Approval is a separate manager act; capturing never books or approves anything.
 *
 * Order: authorize → durable rate-limit → validate (magic bytes + decode + size) → hash ORIGINAL bytes →
 * PRESERVE ORIGINAL (private Blob) → AI on a DERIVED downscaled copy → create row. The stored blob + the
 * evidence hash are the employee's ORIGINAL bytes; the downscale is a throwaway used only for extraction.
 * If storage fails we DO NOT report success. No money movement; no QuickBooks mutation.
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { uploadPrivatePhoto } from '@/platform/blob'
import { extractExpense } from '@/apps/expenses/ai'
import { createReceipt, storedPathnameForHash, consumeRateLimit, RATE_LIMITS } from '@/apps/expenses/db'
import { validateReceiptUpload, extForMime, MAX_UPLOAD_BYTES, MAX_DECLARED_OVERHEAD } from '@/apps/expenses/upload-validation'
import { decodeImageMeta, validateDecodedMeta, derivedForExtraction } from '@/apps/expenses/image-decode'
import { receiptUploaderFromRequest } from '@/apps/expenses/authz'
import { errorCode } from '@/apps/expenses/errors'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const APP = 'expenses:receipt'

/** Rate-limit bucket for an uploader: the SERVER-VERIFIED actor key when known; otherwise a shared-device
 *  bucket keyed by a hashed client IP (a fallback for anonymous shared-PIN devices — never the sole
 *  identity for an authenticated user). */
function uploadBucket(actorKey: string | null, ip: string): string {
  if (actorKey) return `upload:actor:${actorKey}`
  return `upload:shared:${createHash('sha256').update(ip).digest('hex').slice(0, 16)}`
}

export async function POST(req: Request) {
  try {
    // 1) Authorize (FAIL-CLOSED) BEFORE any work — verified session required even if no PIN is configured.
    const uploader = await receiptUploaderFromRequest(req)
    if (!uploader) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })

    // 2) Durable, server-enforced rate limit (bucketed by verified actor; IP only for shared devices).
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const rl = await consumeRateLimit(uploadBucket(uploader.actor?.key ?? null, ip), RATE_LIMITS.upload.limit, RATE_LIMITS.upload.windowMs)
    if (!rl.ok) return NextResponse.json({ ok: false, error: `Too many uploads — try again in ${rl.retryAfterSec}s.` }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec ?? 60) } })

    // 3) Reject oversized uploads early (before buffering the multipart body).
    const declaredLen = parseInt(req.headers.get('content-length') || '0', 10)
    if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BYTES + MAX_DECLARED_OVERHEAD) return NextResponse.json({ ok: false, error: 'Image too large' }, { status: 413 })

    // 4) Validate: magic bytes (authoritative type) + size, then a real image DECODE. The ORIGINAL bytes
    //    are what we hash + store — never a re-encoded copy.
    const form = await req.formData()
    const image = (form.get('receipt') || form.get('image')) as File | null
    if (!image) return NextResponse.json({ ok: false, error: 'No image provided' }, { status: 400 })
    const bytes = Buffer.from(await image.arrayBuffer())
    const v = validateReceiptUpload(image.type, bytes.length, bytes.subarray(0, 16))
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: v.status })
    const decoded = validateDecodedMeta(await decodeImageMeta(bytes))
    if (!decoded.ok) return NextResponse.json({ ok: false, error: decoded.error }, { status: 415 })
    const contentType = v.mime
    const imageHash = createHash('sha256').update(bytes).digest('hex') // hash of the ORIGINAL bytes

    // 5) PRESERVE THE ORIGINAL FIRST (private Blob), immutable. Reuse the pathname if these exact bytes were
    //    ever stored (any prior receipt). A storage failure HARD-FAILS — never a phantom "sent to review".
    let storageRef = await storedPathnameForHash(imageHash).catch(() => null)
    if (!storageRef) {
      try {
        storageRef = await uploadPrivatePhoto(`business-receipts/${imageHash}.${extForMime(contentType)}`, bytes, contentType)
      } catch (err) {
        logger.error(APP, 'storage_failed', { code: errorCode(err) })
        return NextResponse.json({ ok: false, error: 'Could not save the photo — check your connection and try again.' }, { status: 502 })
      }
    }

    // 6) AI extraction on a DERIVED downscaled copy (never stored/hashed). Never throws; failed → manual.
    const derived = await derivedForExtraction(bytes)
    const ai = await extractExpense(derived.bytes.toString('base64'), derived.contentType)
    const e = ai.extraction

    // 7) Create the row — DB-idempotent (unique hash). Concurrent identical uploads collapse to one row.
    const { id: receiptId, duplicate } = await createReceipt({
      storage: 'blob_private', storageRef, filename: image.name, contentType, imageHash, byteSize: bytes.length,
      aiStatus: ai.status, aiModel: ai.model, aiRaw: ai.raw, aiExtracted: e, confidence: e.present, uploadedBy: uploader.name,
      vendor: e.vendor, receiptDate: e.date, subtotalCents: e.subtotalCents, taxCents: e.taxCents,
      totalCents: e.totalCents, category: e.categoryKey, paymentMethod: e.paymentMethod, paymentLast4: e.paymentLast4,
    })

    logger.info(APP, 'captured', { aiStatus: ai.status, duplicate })
    // Never disclose another receipt's metadata to an employee — only whether THIS upload was a duplicate.
    return NextResponse.json({ ok: true, receiptId: duplicate ? undefined : receiptId, aiStatus: ai.status, duplicate })
  } catch (err) {
    logger.error(APP, 'failed', { code: errorCode(err) })
    return NextResponse.json({ ok: false, error: 'Could not process receipt — try again or enter it later.' }, { status: 500 })
  }
}
