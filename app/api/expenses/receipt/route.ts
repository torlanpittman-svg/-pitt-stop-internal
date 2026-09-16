/**
 * POST /api/expenses/receipt  (multipart: receipt)
 *
 * General business-expense receipt capture (Detail AND Auto Sales). Employee-safe surface, but FAIL-CLOSED:
 * it requires a SERVER-VERIFIED session (receiptUploaderFromRequest) — an anonymous caller is rejected even
 * when no PIN is configured. Approval is a separate manager act; capturing never books or approves anything.
 *
 * Order: authorize → rate-limit → validate (magic bytes + decode + size) → hash → PRESERVE ORIGINAL
 * (private Blob) → AI → create row. Storage is preserved BEFORE extraction; if it fails we DO NOT report
 * success (no phantom "sent to review"). No money movement; no QuickBooks mutation.
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { uploadPrivatePhoto } from '@/platform/blob'
import { extractExpense } from '@/apps/expenses/ai'
import { createReceipt, storedPathnameForHash } from '@/apps/expenses/db'
import { validateReceiptUpload, extForMime, MAX_UPLOAD_BYTES, MAX_DECLARED_OVERHEAD } from '@/apps/expenses/upload-validation'
import { decodeImageMeta, validateDecodedMeta } from '@/apps/expenses/image-decode'
import { receiptUploaderFromRequest } from '@/apps/expenses/authz'
import { errorCode } from '@/apps/expenses/errors'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const APP = 'expenses:receipt'

// Best-effort in-memory per-IP limit (per instance). Not a durable cross-instance control; the durable
// guards are the DB unique-hash idempotency (no duplicate expense) and the per-receipt retry lock.
const hits = new Map<string, number[]>()
const RL_WINDOW_MS = 60_000, RL_MAX = 20
function rateLimited(ip: string): boolean {
  const now = Date.now(); const arr = (hits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS)
  arr.push(now); hits.set(ip, arr)
  return arr.length > RL_MAX
}

export async function POST(req: Request) {
  try {
    // 1) Authorize (FAIL-CLOSED) BEFORE any work — verified session required even if no PIN is configured.
    const uploader = await receiptUploaderFromRequest(req)
    if (!uploader) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })

    // 2) Rate limit (best-effort).
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (rateLimited(ip)) return NextResponse.json({ ok: false, error: 'Slow down a moment and try again.' }, { status: 429 })

    // 3) Reject oversized uploads early (before buffering the multipart body).
    const declaredLen = parseInt(req.headers.get('content-length') || '0', 10)
    if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BYTES + MAX_DECLARED_OVERHEAD) return NextResponse.json({ ok: false, error: 'Image too large' }, { status: 413 })

    // 4) Validate request: magic bytes (authoritative type), size, then a real image DECODE.
    const form = await req.formData()
    const image = (form.get('receipt') || form.get('image')) as File | null
    if (!image) return NextResponse.json({ ok: false, error: 'No image provided' }, { status: 400 })
    const bytes = Buffer.from(await image.arrayBuffer())
    const v = validateReceiptUpload(image.type, bytes.length, bytes.subarray(0, 16))
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: v.status })
    const decoded = validateDecodedMeta(await decodeImageMeta(bytes))
    if (!decoded.ok) return NextResponse.json({ ok: false, error: decoded.error }, { status: 415 })
    const contentType = v.mime
    const imageHash = createHash('sha256').update(bytes).digest('hex')

    // 5) PRESERVE THE ORIGINAL FIRST (private Blob). Reuse the immutable pathname if these exact bytes were
    //    ever stored (any prior receipt, incl. rejected) — avoids a re-upload conflict. If the upload fails
    //    we HARD-FAIL — never report a saved receipt when its evidence was lost.
    let storageRef = await storedPathnameForHash(imageHash).catch(() => null)
    if (!storageRef) {
      try {
        storageRef = await uploadPrivatePhoto(`business-receipts/${imageHash}.${extForMime(contentType)}`, bytes, contentType)
      } catch (err) {
        logger.error(APP, 'storage_failed', { code: errorCode(err) })
        return NextResponse.json({ ok: false, error: 'Could not save the photo — check your connection and try again.' }, { status: 502 })
      }
    }

    // 6) AI extraction (never throws; failed → empty proposal → manual entry). Uploader identity is the
    //    SERVER-VERIFIED session name (never a client header/body).
    const ai = await extractExpense(bytes.toString('base64'), contentType)
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
