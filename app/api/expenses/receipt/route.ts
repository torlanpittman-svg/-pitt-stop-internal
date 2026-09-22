/**
 * POST /api/expenses/receipt  (multipart: receipt, captureId)
 *
 * FAST DURABLE SAVE — separates "saved" from "read". It preserves the ORIGINAL image and creates a
 * recoverable receipt row BEFORE any AI, then returns immediately so the employee sees "photo saved" as
 * soon as the evidence is durable. New clients receive a streamed save acknowledgement, then read the same uploaded bytes;
 * old clients and retries use POST .../[id]/extract; a slow or failed read can never lose the receipt or make capture feel lost.
 *
 * Order: authorize → durable rate-limit → validate (magic bytes + decode + size) → hash ORIGINAL bytes →
 * capture_id / hash dedup → PRESERVE ORIGINAL (private Blob) → create PENDING row → return {receiptId,
 * fileToken} → optional streamed read. A storage failure HARD-FAILS (never a phantom "saved"). No money movement or QB.
 *
 * Idempotent: a retry carries the SAME captureId, so a lost/timed-out response never creates a second
 * purchase — the retry resumes the already-saved receipt (with its extracted proposal if the read finished).
 */
import { extractSavedReceipt } from '@/apps/expenses/extract-saved'
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { uploadPrivatePhoto } from '@/platform/blob'
import { createPendingReceipt, findReceiptByCaptureId, findActiveReceiptByHash, storedPathnameForHash, consumeRateLimit, RATE_LIMITS, type ReceiptRow } from '@/apps/expenses/db'
import { validateReceiptUpload, extForMime, MAX_UPLOAD_BYTES, MAX_DECLARED_OVERHEAD } from '@/apps/expenses/upload-validation'
import { decodeImageMeta, validateDecodedMeta } from '@/apps/expenses/image-decode'
import { receiptUploaderFromRequest, type Uploader } from '@/apps/expenses/authz'
import { signCaptureToken } from '@/apps/expenses/capture-token'
import { matchPaymentSource } from '@/apps/expenses/payment'
import { errorCode } from '@/apps/expenses/errors'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // streamed save acknowledgement precedes the bounded read
const APP = 'expenses:receipt'

function uploadBucket(actorKey: string | null, ip: string): string {
  if (actorKey) return `upload:actor:${actorKey}`
  return `upload:shared:${createHash('sha256').update(ip).digest('hex').slice(0, 16)}`
}
/** Does this uploader own (or share the device of) this receipt? Governs whether we resume it with a token. */
function ownsForResume(uploader: Uploader, row: ReceiptRow): boolean {
  const key = uploader.actor?.key ?? null
  return row.uploadedByKey === key // named-key match, or both null (same shared device)
}
/** The client-safe resume payload for an already-saved receipt (its confirmed vendor/date/total only). */
function resumePayload(row: ReceiptRow) {
  const present = (row.confidence && typeof row.confidence === 'object' ? row.confidence : null) as Record<string, boolean> | null
  return {
    ok: true as const, receiptId: row.id, fileToken: signCaptureToken(row.id), duplicate: true, resumed: true,
    aiStatus: row.aiStatus,
    proposal: row.aiStatus === 'extracted'
      ? { vendor: row.vendor, date: row.receiptDate, totalCents: row.totalCents, categoryKey: row.category, paymentChoice: matchPaymentSource({ method: row.paymentMethod, brand: null, cardLast4: row.paymentLast4 }), present: present ?? {} }
      : null,
  }
}

export async function POST(req: Request) {
  const started = Date.now()
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

    const form = await req.formData()
    const captureId = ((form.get('captureId') as string | null) || '').trim().slice(0, 64) || null

    // 3b) RETRY RESUME: a repeat with the same captureId returns the already-saved receipt (never a 2nd row).
    if (captureId) {
      const prior = await findReceiptByCaptureId(captureId).catch(() => null)
      if (prior) {
        if (ownsForResume(uploader, prior)) return NextResponse.json(resumePayload(prior))
        return NextResponse.json({ ok: true, duplicate: true, alreadyCaptured: true }) // never hand another's receipt
      }
    }

    // 4) Validate: magic bytes (authoritative type) + size, then a real image DECODE (metadata only — fast).
    const image = (form.get('receipt') || form.get('image')) as File | null
    if (!image) return NextResponse.json({ ok: false, error: 'No image provided' }, { status: 400 })
    const bytes = Buffer.from(await image.arrayBuffer())
    const v = validateReceiptUpload(image.type, bytes.length, bytes.subarray(0, 16))
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: v.status })
    const decoded = validateDecodedMeta(await decodeImageMeta(bytes))
    if (!decoded.ok) return NextResponse.json({ ok: false, error: decoded.error }, { status: 415 })
    const contentType = v.mime
    const imageHash = createHash('sha256').update(bytes).digest('hex') // hash of the ORIGINAL bytes

    // 4b) IDENTICAL-BYTES duplicate from a DIFFERENT capture → already captured (no second purchase, no token).
    const byHash = await findActiveReceiptByHash(imageHash).catch(() => null)
    if (byHash && byHash.captureId !== captureId) return NextResponse.json({ ok: true, duplicate: true, alreadyCaptured: true })

    // 5) PRESERVE THE ORIGINAL FIRST (private Blob), immutable. Reuse the pathname if these exact bytes were
    //    ever stored. A storage failure HARD-FAILS — never a phantom "saved".
    let storageRef = await storedPathnameForHash(imageHash).catch(() => null)
    if (!storageRef) {
      try {
        storageRef = await uploadPrivatePhoto(`business-receipts/${imageHash}.${extForMime(contentType)}`, bytes, contentType)
      } catch (err) {
        logger.error(APP, 'storage_failed', { code: errorCode(err) })
        return NextResponse.json({ ok: false, error: 'Could not save the photo — check your connection and try again.' }, { status: 502 })
      }
    }

    // 6) Create the recoverable PENDING row (no AI yet). DB-idempotent on capture_id + hash.
    const { id: receiptId, duplicate } = await createPendingReceipt({
      storageRef, filename: image.name, contentType, imageHash, byteSize: bytes.length, captureId,
      uploadedBy: uploader.name, uploadedByKey: uploader.actor?.key ?? null,
    })
    if (duplicate) {
      const prior = captureId ? await findReceiptByCaptureId(captureId).catch(() => null) : null
      if (prior && ownsForResume(uploader, prior)) return NextResponse.json(resumePayload(prior))
      return NextResponse.json({ ok: true, duplicate: true, alreadyCaptured: true })
    }

    logger.info(APP, 'saved', { hasCapture: !!captureId, saveMs: Date.now() - started })
    // Photo is durably saved; acknowledge it before reading. The token authorizes THIS row.
    const saved = { ok: true, receiptId, fileToken: signCaptureToken(receiptId), duplicate: false, aiStatus: 'pending', proposal: null }
    // Old clients still receive the fast JSON save and use the retry endpoint.
    if (!req.headers.get('accept')?.includes('application/x-ndjson')) return NextResponse.json(saved)
    const encoder = new TextEncoder()
    let disconnected = false
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: unknown) => { if (!disconnected) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')) }
        send({ type: 'saved', ...saved })
        try {
          const result = await extractSavedReceipt(receiptId, uploader, saved.fileToken, { bytes, contentType })
          send({ type: 'read', ...await result.json() })
        } catch {
          send({ type: 'read', ok: false, aiStatus: 'failed' })
        } finally {
          if (!disconnected) controller.close()
        }
      },
      cancel() { disconnected = true },
    })
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform' } })
  } catch (err) {
    logger.error(APP, 'failed', { code: errorCode(err) })
    return NextResponse.json({ ok: false, error: 'Could not save the photo — try again.' }, { status: 500 })
  }
}
