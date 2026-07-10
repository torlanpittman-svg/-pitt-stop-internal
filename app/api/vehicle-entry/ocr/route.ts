import { NextResponse } from 'next/server'
import { extractVehicleData } from '@/apps/vehicle-entry/ai'
import { createVehicleEntry } from '@/apps/vehicle-entry/db'
import { uploadPhoto } from '@/platform/blob'
import { logger } from '@/platform/logger'
import { isAcceptedMimeType } from '@/platform/image'

const LOG = 'api:vehicle-entry:ocr'
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB (client compresses to ≤1.5 MB)

export async function POST(request: Request) {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json(
      { error: 'Invalid request: expected multipart/form-data' },
      { status: 400 }
    )
  }

  const file = formData.get('image') as File | null
  if (!file || file.size === 0) {
    return NextResponse.json({ error: 'No image provided' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image too large (max 5 MB, got ${(file.size / 1024 / 1024).toFixed(1)} MB)` },
      { status: 413 }
    )
  }

  const mimeType = file.type || 'image/jpeg'
  if (!isAcceptedMimeType(mimeType)) {
    return NextResponse.json(
      { error: `Unsupported image type: ${mimeType}` },
      { status: 400 }
    )
  }

  const bytes = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)
  const base64 = buffer.toString('base64')

  logger.info(LOG, 'extraction.start', { filename: file.name, bytes: file.size, mimeType })

  // Run AI extraction
  let ocrResult
  try {
    ocrResult = await extractVehicleData(base64, mimeType)
  } catch (err) {
    logger.error(LOG, 'extraction.failed', { error: String(err) })
    return NextResponse.json(
      { error: 'AI extraction failed. Check server logs for details.' },
      { status: 500 }
    )
  }

  // Store photo — demo mode stores base64 inline, production uses Vercel Blob
  let photoUrl: string
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    photoUrl = `data:${mimeType};base64,${base64}`
    logger.info(LOG, 'photo.stored.demo', { bytes: base64.length })
  } else {
    try {
      photoUrl = await uploadPhoto('vehicle-entry', file.name, buffer, mimeType)
    } catch (err) {
      logger.error(LOG, 'photo.upload.failed', { error: String(err) })
      return NextResponse.json({ error: 'Photo storage failed' }, { status: 500 })
    }
  }

  const entryId = await createVehicleEntry({
    photoUrl,
    year:           ocrResult.year,
    make:           ocrResult.make,
    model:          ocrResult.model,
    color:          ocrResult.color,
    stockNumber:    ocrResult.stockNumber,
    ocrConfidence:  ocrResult.confidence as unknown as Record<string, number>,
    rawOcrResponse: ocrResult.rawResponse,
  })

  logger.info(LOG, 'extraction.complete', {
    id:         entryId,
    provider:   ocrResult.providerName,
    confidence: ocrResult.confidence,
  })

  return NextResponse.json({
    id:           entryId,
    year:         ocrResult.year,
    make:         ocrResult.make,
    model:        ocrResult.model,
    color:        ocrResult.color,
    stockNumber:  ocrResult.stockNumber,
    confidence:   ocrResult.confidence,
    providerName: ocrResult.providerName,
  })
}
