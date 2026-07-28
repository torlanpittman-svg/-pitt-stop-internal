/**
 * POST /api/dealer-checkin/ocr  (multipart: tagImage)
 * Runs the proven key-tag OCR pipeline on a dealer tag photo and returns the
 * stock number + color (+ year/make/model as fallback) with confidence, so the
 * check-in UI can auto-fill and decide whether a retake is needed.
 */
import { NextResponse } from 'next/server'
import { extractVehicleData } from '@/apps/vehicle-entry/ai'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const form = await req.formData()
    const image = form.get('tagImage') as File | null
    if (!image) return NextResponse.json({ error: 'No tagImage provided' }, { status: 400 })

    const base64 = Buffer.from(await image.arrayBuffer()).toString('base64')
    const result = await extractVehicleData(base64, image.type || 'image/jpeg')

    const conf = result.confidence
    const stockConfidence = typeof conf?.stockNumber === 'number' ? Math.round(conf.stockNumber * 100) : null
    const colorConfidence = typeof conf?.color === 'number' ? Math.round(conf.color * 100) : null

    const durationMs = Date.now() - started
    logger.info('dealer-checkin:ocr', 'extracted', {
      stockNumber: result.stockNumber, color: result.color, stockConfidence, durationMs,
    })

    return NextResponse.json({
      ok: true,
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
    logger.error('dealer-checkin:ocr', 'failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
