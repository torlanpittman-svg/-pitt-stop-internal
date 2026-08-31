/**
 * POST /api/dealer-checkin/ocr  (multipart: tagImage)
 *
 * The single OCR pipeline for BOTH "Take Photo" and "Upload Photo". Stores the
 * original tag image in Vercel Blob (deduped by content hash) and runs the
 * key-tag OCR. Returns the stored image URL, the raw OCR output (for audit —
 * never shown to employees), and the extracted fields (stock/color/vehicle).
 *
 * Image storage degrades gracefully: if the Blob store isn't configured yet, the
 * OCR still returns and photoUrl is null (the check-in flow keeps working).
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { extractVehicleData } from '@/apps/vehicle-entry/ai'
import { uploadPhoto } from '@/platform/blob'
import { findImageUrlByHash } from '@/apps/dealer-checkin/db'
import { sanitizeRawOcr } from '@/apps/dealer-checkin/rules'
import { employeeAuthorizedFromRequest } from '@/apps/auth/employee-guard'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const APP = 'dealer-checkin:ocr'

export async function POST(req: Request) {
  const started = Date.now()
  try {
    // Defense-in-depth (proxy.ts is the primary gate): never run OCR/AI for an unauthenticated caller.
    if (!(await employeeAuthorizedFromRequest(req))) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
    const form = await req.formData()
    const image = (form.get('tagImage') || form.get('image')) as File | null
    if (!image) return NextResponse.json({ ok: false, error: 'No image provided' }, { status: 400 })

    const bytes = Buffer.from(await image.arrayBuffer())
    const contentType = image.type || 'image/jpeg'
    const imageHash = createHash('sha256').update(bytes).digest('hex')

    // Store the original image (dedup identical bytes; degrade if Blob unset).
    let photoUrl: string | null = null
    try {
      photoUrl = await findImageUrlByHash(imageHash)
      if (!photoUrl) {
        photoUrl = await uploadPhoto('dealer-checkin', `${imageHash.slice(0, 12)}.jpg`, bytes, contentType)
      }
    } catch (err) {
      logger.warn(APP, 'image_store_skipped', { error: String(err) })
    }

    const result = await extractVehicleData(bytes.toString('base64'), contentType)

    const conf = result.confidence
    const stockConfidence = typeof conf?.stockNumber === 'number' ? Math.round(conf.stockNumber * 100) : null
    const colorConfidence = typeof conf?.color === 'number' ? Math.round(conf.color * 100) : null
    const durationMs = Date.now() - started

    logger.info(APP, 'extracted', { stockNumber: result.stockNumber, color: result.color, stored: !!photoUrl, durationMs })

    return NextResponse.json({
      ok: true,
      photoUrl,
      imageHash,
      // Compact, Postgres-safe OCR metadata for the audit record — never the
      // base64/image/binary debug artifacts (those bloat the row and can carry
      // NUL/control chars that crash the jsonb INSERT).
      rawOcr:      sanitizeRawOcr(result),
      stockNumber: result.stockNumber ?? null,
      color:       result.color ?? null,
      year:        result.year ?? null,
      make:        result.make ?? null,
      model:       result.model ?? null,
      stockConfidence,
      colorConfidence,
      durationMs,
    })
  } catch (err) {
    logger.error(APP, 'failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
