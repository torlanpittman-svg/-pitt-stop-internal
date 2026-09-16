/**
 * POST /api/expenses/receipt  (multipart: receipt)
 *
 * General business-expense receipt capture (Detail AND Auto Sales). Employee-safe surface: capture is
 * an ordinary operational act (any signed-in employee can snap/upload a receipt), so it is gated by the
 * EMPLOYEE_PIN session (proxy.ts) and re-verified here as defense-in-depth on the EXPENSIVE OpenAI call.
 * APPROVAL is a separate manager act (server actions) — capturing never books or approves anything.
 *
 * Order: authorize → rate-limit → validate (type/size) → hash → dedup/Blob → AI → create row (needs_review).
 * The original image is preserved even if AI fails, so a receipt is never stranded. No money movement;
 * no QuickBooks mutation.
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { uploadPhoto } from '@/platform/blob'
import { isAcceptedMimeType } from '@/platform/image'
import { extractExpense } from '@/apps/expenses/ai'
import { createReceipt, findReceiptByHash } from '@/apps/expenses/db'
import { employeeAuthorizedFromRequest, authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const APP = 'expenses:receipt'
const MAX_BYTES = 12 * 1024 * 1024 // 12 MB — generous for a phone photo, rejects abuse

// Generous in-memory rate limit (per instance): normal shop use never hits it.
const hits = new Map<string, number[]>()
const RL_WINDOW_MS = 60_000, RL_MAX = 30
function rateLimited(ip: string): boolean {
  const now = Date.now(); const arr = (hits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS)
  arr.push(now); hits.set(ip, arr)
  return arr.length > RL_MAX
}

export async function POST(req: Request) {
  try {
    // 1) Authorize BEFORE any work (never reach OpenAI unauthenticated).
    if (!(await employeeAuthorizedFromRequest(req))) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })

    // 2) Rate limit.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (rateLimited(ip)) return NextResponse.json({ ok: false, error: 'Slow down a moment and try again.' }, { status: 429 })

    // 3) Reject oversized uploads early (before buffering the multipart body).
    const declaredLen = parseInt(req.headers.get('content-length') || '0', 10)
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES + 512 * 1024) return NextResponse.json({ ok: false, error: 'Image too large' }, { status: 413 })

    // 4) Validate request.
    const form = await req.formData()
    const image = (form.get('receipt') || form.get('image')) as File | null
    if (!image) return NextResponse.json({ ok: false, error: 'No image provided' }, { status: 400 })
    const contentType = image.type || 'image/jpeg'
    if (!isAcceptedMimeType(contentType)) return NextResponse.json({ ok: false, error: 'Unsupported image type' }, { status: 400 })
    if (image.size > MAX_BYTES) return NextResponse.json({ ok: false, error: 'Image too large' }, { status: 413 })

    const bytes = Buffer.from(await image.arrayBuffer())
    if (bytes.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'Image too large' }, { status: 413 })
    const imageHash = createHash('sha256').update(bytes).digest('hex')

    // 5) Duplicate protection: same content hash already captured?
    const prior = await findReceiptByHash(imageHash).catch(() => null)
    const duplicateWarning = prior ? { receiptId: prior.id, when: prior.createdAt, status: prior.status } : null

    // 6) Store the original image (reuse the existing Blob URL for identical bytes → no duplicate copies).
    let storageRef: string | null = prior?.storageRef ?? null
    let storage: 'blob_public' | 'none' = storageRef ? 'blob_public' : 'none'
    if (!storageRef) {
      try { storageRef = await uploadPhoto('business-receipts', `${imageHash.slice(0, 12)}.jpg`, bytes, contentType); storage = 'blob_public' }
      catch (err) { logger.warn(APP, 'blob_skipped', { error: String(err) }); storage = 'none' }
    }

    // 7) AI extraction (never throws; failed → empty proposal for manual entry). Uploader identity is
    //    taken from the SERVER-VERIFIED session (never a client-writable header/body).
    const actor = await authenticatedActorFromRequest(req).catch(() => null)
    const uploader = actor?.name ?? 'shop'
    const ai = await extractExpense(bytes.toString('base64'), contentType)
    const e = ai.extraction

    const receiptId = await createReceipt({
      storage, storageRef, filename: image.name, contentType, imageHash, byteSize: bytes.length,
      aiStatus: ai.status, aiModel: ai.model, aiRaw: ai.raw, aiExtracted: e, confidence: e.present, uploadedBy: uploader,
      vendor: e.vendor, receiptDate: e.date, subtotalCents: e.subtotalCents, taxCents: e.taxCents,
      totalCents: e.totalCents, category: e.categoryKey, paymentMethod: e.paymentMethod, paymentLast4: e.paymentLast4,
    })

    logger.info(APP, 'captured', { receiptId, aiStatus: ai.status, stored: storage, dup: !!duplicateWarning })
    return NextResponse.json({ ok: true, receiptId, aiStatus: ai.status, duplicateWarning })
  } catch (err) {
    logger.error(APP, 'failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: 'Could not process receipt — try again or enter it later.' }, { status: 500 })
  }
}
