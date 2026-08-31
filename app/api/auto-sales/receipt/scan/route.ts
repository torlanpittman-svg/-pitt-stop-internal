/**
 * POST /api/auto-sales/receipt/scan  (multipart: receipt, inventoryVehicleId)
 *
 * The single receipt pipeline for both Take Photo and Upload Photo. PUBLIC (employee /auto-sales — no
 * admin password); it only ingests an ordinary receipt for a vehicle the employee is already inside.
 * Reuses the proven dealer-checkin pattern: sha-256 hash → dedup existing Blob (no duplicate copies) →
 * Vercel Blob → GPT-4o extraction. Persists a vehicle_documents row immediately so a failed/blurry
 * extraction never strands the receipt — the employee then verifies/enters the fields and Saves.
 *
 * Degrades gracefully: Blob unset → storage 'none' (row still created); AI error → aiStatus 'failed'
 * with an empty proposal for manual entry. Duplicate (same bytes) → warns, does not block.
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { uploadPhoto } from '@/platform/blob'
import { extractReceipt } from '@/apps/auto-sales/ai/receipt'
import { findDocumentByHash, createReceiptDocument } from '@/apps/auto-sales/db'
import { isAcceptedMimeType } from '@/platform/image'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const APP = 'auto-sales:receipt:scan'

export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const image = (form.get('receipt') || form.get('image')) as File | null
    const inventoryVehicleId = String(form.get('inventoryVehicleId') ?? '')
    if (!image) return NextResponse.json({ ok: false, error: 'No image provided' }, { status: 400 })
    if (!inventoryVehicleId) return NextResponse.json({ ok: false, error: 'Missing vehicle' }, { status: 400 })

    const bytes = Buffer.from(await image.arrayBuffer())
    const contentType = image.type || 'image/jpeg'
    if (!isAcceptedMimeType(contentType)) return NextResponse.json({ ok: false, error: 'Unsupported image type' }, { status: 400 })
    const imageHash = createHash('sha256').update(bytes).digest('hex')

    // Duplicate protection (§12): same content hash already captured?
    const priorSameBytes = await findDocumentByHash(imageHash).catch(() => null)
    const duplicateWarning = priorSameBytes
      ? { documentId: priorSameBytes.id, sameVehicle: priorSameBytes.inventoryVehicleId === inventoryVehicleId, when: priorSameBytes.createdAt }
      : null

    // Store the original image (reuse existing Blob URL for identical bytes → no duplicate copies).
    let storageRef: string | null = priorSameBytes?.storageRef ?? null
    let storage: 'blob_public' | 'none' = storageRef ? 'blob_public' : 'none'
    if (!storageRef) {
      try { storageRef = await uploadPhoto('auto-sales-receipts', `${imageHash.slice(0, 12)}.jpg`, bytes, contentType); storage = 'blob_public' }
      catch (err) { logger.warn(APP, 'blob_skipped', { error: String(err) }); storage = 'none' }
    }

    // AI extraction (never throws; failed → empty proposal for manual entry).
    const ai = await extractReceipt(bytes.toString('base64'), contentType)

    const documentId = await createReceiptDocument({
      inventoryVehicleId, storage, storageRef, filename: image.name, contentType, imageHash, byteSize: bytes.length,
      aiStatus: ai.status, aiModel: ai.model, aiRaw: ai.raw, aiExtracted: ai.extraction, uploadedBy: 'auto-sales',
    })

    logger.info(APP, 'scanned', { vehicle: inventoryVehicleId, aiStatus: ai.status, stored: storage, dup: !!duplicateWarning })
    return NextResponse.json({ ok: true, documentId, storageRef, imageHash, aiStatus: ai.status, proposal: ai.extraction, duplicateWarning })
  } catch (err) {
    logger.error(APP, 'failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: 'Could not process receipt — enter it manually.' }, { status: 500 })
  }
}
