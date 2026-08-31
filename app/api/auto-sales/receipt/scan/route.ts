/**
 * POST /api/auto-sales/receipt/scan  (multipart: receipt, inventoryVehicleId)
 *
 * The single receipt pipeline for both Take Photo and Upload Photo. Employee surface (gated by the
 * EMPLOYEE_PIN session in proxy.ts). This route re-verifies authorization as defense-in-depth on the
 * EXPENSIVE OpenAI endpoint, then rate-limits + validates BEFORE any AI call. Reuses the proven
 * dealer-checkin pattern: sha-256 hash → dedup existing Blob (no duplicate copies) → Vercel Blob →
 * GPT-4o. Persists a vehicle_documents row so a failed/blurry extraction never strands the receipt.
 *
 * Order: authorize → rate-limit → validate (type/size) → hash/blob → AI → create document.
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { uploadPhoto } from '@/platform/blob'
import { extractReceipt } from '@/apps/auto-sales/ai/receipt'
import { findDocumentByHash, createReceiptDocument, proposeReturnMatch } from '@/apps/auto-sales/db'
import { isAcceptedMimeType } from '@/platform/image'
import { EMP_COOKIE, employeePinConfigured, verifyEmployeeToken } from '@/apps/auto-sales/session'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const APP = 'auto-sales:receipt:scan'
const MAX_BYTES = 12 * 1024 * 1024 // 12 MB — generous for a phone photo, rejects abuse

// Generous in-memory rate limit (per instance): normal shop use never hits it.
const hits = new Map<string, number[]>()
const RL_WINDOW_MS = 60_000, RL_MAX = 30
function rateLimited(ip: string): boolean {
  const now = Date.now(); const arr = (hits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS)
  arr.push(now); hits.set(ip, arr)
  return arr.length > RL_MAX
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const p of header.split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === name) return p.slice(i + 1).trim() }
  return null
}
async function authorized(req: Request): Promise<boolean> {
  if (!employeePinConfigured()) return true // no PIN configured = open (dev), matches middleware
  const adminPassword = process.env.ADMIN_PASSWORD
  const auth = req.headers.get('authorization')
  if (adminPassword && auth?.startsWith('Basic ')) {
    try { const c = atob(auth.slice(6)); if (c.slice(c.indexOf(':') + 1).trim() === adminPassword.trim()) return true } catch { /* ignore */ }
  }
  return !!(await verifyEmployeeToken(readCookie(req.headers.get('cookie'), EMP_COOKIE)))
}

export async function POST(req: Request) {
  try {
    // 1) Authorize BEFORE any work (never reach OpenAI unauthenticated).
    if (!(await authorized(req))) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })

    // 2) Rate limit.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (rateLimited(ip)) return NextResponse.json({ ok: false, error: 'Slow down a moment and try again.' }, { status: 429 })

    // 3) Reject oversized uploads early (before buffering the multipart body).
    const declaredLen = parseInt(req.headers.get('content-length') || '0', 10)
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES + 512 * 1024) return NextResponse.json({ ok: false, error: 'Image too large' }, { status: 413 })

    // 4) Validate request.
    const form = await req.formData()
    const image = (form.get('receipt') || form.get('image')) as File | null
    const inventoryVehicleId = String(form.get('inventoryVehicleId') ?? '')
    if (!image) return NextResponse.json({ ok: false, error: 'No image provided' }, { status: 400 })
    if (!inventoryVehicleId) return NextResponse.json({ ok: false, error: 'Missing vehicle' }, { status: 400 })
    const contentType = image.type || 'image/jpeg'
    if (!isAcceptedMimeType(contentType)) return NextResponse.json({ ok: false, error: 'Unsupported image type' }, { status: 400 })
    if (image.size > MAX_BYTES) return NextResponse.json({ ok: false, error: 'Image too large' }, { status: 413 })

    const bytes = Buffer.from(await image.arrayBuffer())
    if (bytes.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'Image too large' }, { status: 413 })
    const imageHash = createHash('sha256').update(bytes).digest('hex')

    // 4) Duplicate protection (§12): same content hash already captured?
    const priorSameBytes = await findDocumentByHash(imageHash).catch(() => null)
    const duplicateWarning = priorSameBytes
      ? { documentId: priorSameBytes.id, sameVehicle: priorSameBytes.inventoryVehicleId === inventoryVehicleId, when: priorSameBytes.createdAt }
      : null

    // 5) Store the original image (reuse existing Blob URL for identical bytes → no duplicate copies).
    let storageRef: string | null = priorSameBytes?.storageRef ?? null
    let storage: 'blob_public' | 'none' = storageRef ? 'blob_public' : 'none'
    if (!storageRef) {
      try { storageRef = await uploadPhoto('auto-sales-receipts', `${imageHash.slice(0, 12)}.jpg`, bytes, contentType); storage = 'blob_public' }
      catch (err) { logger.warn(APP, 'blob_skipped', { error: String(err) }); storage = 'none' }
    }

    // 6) AI extraction (never throws; failed → empty proposal for manual entry).
    const ai = await extractReceipt(bytes.toString('base64'), contentType)

    // 6b) If it reads as a return/refund/credit, propose links to this vehicle's prior purchases
    //     (read-only; evidence-based; never fabricates). Employee confirms on the verify screen.
    const returnMatch = ai.extraction.isReturn ? await proposeReturnMatch(inventoryVehicleId, ai.extraction).catch(() => null) : null

    const documentId = await createReceiptDocument({
      inventoryVehicleId, storage, storageRef, filename: image.name, contentType, imageHash, byteSize: bytes.length,
      aiStatus: ai.status, aiModel: ai.model, aiRaw: ai.raw, aiExtracted: ai.extraction, uploadedBy: 'auto-sales',
    })

    logger.info(APP, 'scanned', { vehicle: inventoryVehicleId, aiStatus: ai.status, stored: storage, dup: !!duplicateWarning, ret: returnMatch?.classification })
    return NextResponse.json({ ok: true, documentId, storageRef, imageHash, aiStatus: ai.status, proposal: ai.extraction, duplicateWarning, returnMatch })
  } catch (err) {
    logger.error(APP, 'failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: 'Could not process receipt — enter it manually.' }, { status: 500 })
  }
}
