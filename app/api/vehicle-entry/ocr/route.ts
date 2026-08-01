import { NextResponse } from 'next/server'
import { extractVehicleData } from '@/apps/vehicle-entry/ai'
import { createVehicleEntry, getDealership } from '@/apps/vehicle-entry/db'
import { uploadPhoto } from '@/platform/blob'
import { logger } from '@/platform/logger'
import { isAcceptedMimeType } from '@/platform/image'
import { applyStockNormalizations, detectStockPrefix } from '@/apps/ai-learning/normalizations'

const LOG = 'api:vehicle-entry:ocr'
const MAX_BYTES = 5 * 1024 * 1024

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

  // Primary image — what gets sent to OCR (may be cropped from guided capture)
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

  // Optional full original frame (guided capture only) — stored but not sent to AI
  const originalFile = formData.get('originalImage') as File | null

  const bytes  = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)
  const base64 = buffer.toString('base64')

  const photoTakenAt = new Date()
  logger.info(LOG, 'extraction.start', { filename: file.name, bytes: file.size, mimeType })

  let ocrResult
  try {
    ocrResult = await extractVehicleData(base64, mimeType)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status  = (err as { status?: number })?.status
    const code    = (err as { code?: string })?.code
    logger.error(LOG, 'extraction.failed', { error: message, status, code })
    return NextResponse.json(
      { error: 'AI extraction failed', detail: message, status, code },
      { status: 500 }
    )
  }

  const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN

  // Store full photo
  let photoUrl: string
  if (!hasBlob) {
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

  // Optional crop/overlay images: store in Blob, else null on failure — never
  // base64 when a Blob store is configured (that regrows the DB). The base64
  // branch remains only for the no-Blob dev/demo case. These columns are nullable
  // and non-critical, so a null on failure preserves the workflow.
  async function storeImage(base64: string, suffix: string): Promise<string | null> {
    const mime = 'image/jpeg'
    if (!hasBlob) return `data:${mime};base64,${base64}` // dev/demo only (no Blob store)
    try {
      return await uploadPhoto('vehicle-entry-crops', `${Date.now()}-${suffix}.jpg`, Buffer.from(base64, 'base64'), mime)
    } catch (err) {
      logger.error(LOG, `${suffix}.upload.failed`, { error: String(err) })
      return null
    }
  }

  const stockNumberCropUrl = ocrResult.stockCropBase64
    ? await storeImage(ocrResult.stockCropBase64, 'stock-crop')
    : null

  const stockDebugOverlayUrl = ocrResult.stockDebugOverlayBase64
    ? await storeImage(ocrResult.stockDebugOverlayBase64, 'stock-overlay')
    : null

  // Store the original (pre-crop) frame if provided by guided capture
  let originalPhotoUrl: string | null = null
  if (originalFile && originalFile.size > 0) {
    const origBytes  = await originalFile.arrayBuffer()
    const origBuffer = Buffer.from(origBytes)
    const origMime   = originalFile.type || 'image/jpeg'
    if (!hasBlob) {
      originalPhotoUrl = `data:${origMime};base64,${origBuffer.toString('base64')}`
    } else {
      try {
        originalPhotoUrl = await uploadPhoto('vehicle-entry-originals', originalFile.name, origBuffer, origMime)
      } catch (err) {
        // Optional original frame — null on failure, never base64 (avoid DB regrowth).
        logger.error(LOG, 'original.upload.failed', { error: String(err) })
        originalPhotoUrl = null
      }
    }
  }

  const ocrCompletedAt = new Date()
  const isPilotEntry   = process.env.PILOT_MODE === 'true'

  // Apply normalization rules to raw stock number
  const rawStockOcr = ocrResult.stockNumber
  const normResult  = rawStockOcr
    ? applyStockNormalizations(rawStockOcr)
    : { raw: null, normalized: rawStockOcr, changes: [] }
  const normalizedStock    = rawStockOcr ? normResult.normalized : rawStockOcr
  const detectedPrefix     = normalizedStock ? detectStockPrefix(normalizedStock) : null

  // Resolve dealership expected prefix (if dealer ID was passed in formData)
  const dealershipId   = formData.get('dealershipId') as string | null
  const dealershipName = formData.get('dealershipName') as string | null
  let expectedDealerPrefix: string | null = null
  if (dealershipId) {
    const dealer = await getDealership(dealershipId).catch(() => null)
    expectedDealerPrefix = dealer?.stockPrefix ?? null
  }

  const entryId = await createVehicleEntry({
    photoUrl,
    originalPhotoUrl,
    // Current confirmed values — start equal to normalized AI, overwritten when employee corrects
    year:                    ocrResult.year,
    make:                    ocrResult.make,
    model:                   ocrResult.model,
    color:                   ocrResult.color,
    stockNumber:             normalizedStock,
    stockNumberCropUrl,
    stockNumberAiPrediction: normalizedStock,  // normalized prediction shown to employee
    stockDebugOverlayUrl,
    stockDebugData:          ocrResult.stockDebugData,
    ocrConfidence:           ocrResult.confidence as unknown as Record<string, number>,
    rawOcrResponse:          ocrResult.rawResponse,
    photoTakenAt,
    ocrCompletedAt,
    isPilotEntry,
    dealershipId:            dealershipId   ?? undefined,
    dealershipName:          dealershipName ?? undefined,
    // Original AI predictions — locked at creation, never updated by PATCH
    aiYear:        ocrResult.year,
    aiMake:        ocrResult.make,
    aiModel:       ocrResult.model,
    aiColor:       ocrResult.color,
    promptVersion: ocrResult.promptVersion,
    modelName:     ocrResult.modelName,
    // Stock normalization data
    stockRawOcr:          rawStockOcr,
    normalizationsApplied: normResult.changes as never,
    detectedStockPrefix:   detectedPrefix,
    expectedDealerPrefix,
  })

  logger.info(LOG, 'extraction.complete', {
    id:             entryId,
    provider:       ocrResult.providerName,
    stockConf:      ocrResult.confidence.stockNumber,
    hasCrop:        !!stockNumberCropUrl,
    confidence:     ocrResult.confidence,
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
