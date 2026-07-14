import { NextResponse } from 'next/server'
import { getVehicleEntry } from '@/apps/vehicle-entry/db'
import { extractVehicleData } from '@/apps/vehicle-entry/ai'
import { getDb } from '@/platform/db'
import { ocrPromptResults } from '@/apps/vehicle-entry/schema'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const entryId = typeof body.entryId === 'string' ? body.entryId : null
  if (!entryId) {
    return NextResponse.json({ error: 'entryId required' }, { status: 400 })
  }

  const entry = await getVehicleEntry(entryId)
  if (!entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }

  // Need a photo to re-run — use crop if available, else full photo
  const photoUrl = entry.stockNumberCropUrl ?? entry.photoUrl
  if (!photoUrl || photoUrl.startsWith('manual://') || photoUrl.startsWith('test://') || photoUrl.startsWith('vin://')) {
    return NextResponse.json({ error: 'No reprocessable photo for this entry' }, { status: 422 })
  }

  // Fetch the image
  let imageBase64: string
  let mimeType = 'image/jpeg'
  try {
    if (photoUrl.startsWith('data:')) {
      const match = photoUrl.match(/^data:([^;]+);base64,(.+)/)
      if (!match) throw new Error('Invalid data URL')
      mimeType     = match[1]
      imageBase64  = match[2]
    } else {
      const res = await fetch(photoUrl)
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
      const ct = res.headers.get('content-type')
      if (ct) mimeType = ct.split(';')[0]
      const buf = await res.arrayBuffer()
      imageBase64 = Buffer.from(buf).toString('base64')
    }
  } catch (err) {
    return NextResponse.json({ error: `Could not fetch photo: ${String(err)}` }, { status: 500 })
  }

  // Re-run extraction
  let result
  try {
    result = await extractVehicleData(imageBase64, mimeType)
  } catch (err) {
    return NextResponse.json({ error: `OCR failed: ${String(err)}` }, { status: 500 })
  }

  // Save to ocr_prompt_results — never touches the original entry
  const db = getDb()
  const [row] = await db
    .insert(ocrPromptResults)
    .values({
      entryId,
      promptVersion: result.promptVersion,
      modelName:     result.modelName,
      aiYear:        result.year,
      aiMake:        result.make,
      aiModel:       result.model,
      aiColor:       result.color,
      aiStockNumber: result.stockNumber,
      confidence:    result.confidence as never,
      rawResponse:   result.rawResponse as never,
    })
    .returning()

  // Compute field-level comparison against confirmed ground truth
  const compare = {
    year:  { ai: result.year,        confirmed: entry.year,        match: result.year?.toLowerCase()  === entry.year?.toLowerCase() },
    make:  { ai: result.make,        confirmed: entry.make,        match: result.make?.toLowerCase()  === entry.make?.toLowerCase() },
    model: { ai: result.model,       confirmed: entry.model,       match: result.model?.toLowerCase() === entry.model?.toLowerCase() },
    color: { ai: result.color,       confirmed: entry.color,       match: result.color?.toLowerCase() === entry.color?.toLowerCase() },
    stock: { ai: result.stockNumber, confirmed: entry.stockNumber, match: result.stockNumber === entry.stockNumber },
  }

  return NextResponse.json({
    rerunId: row.id,
    entryId,
    promptVersion: result.promptVersion,
    modelName:     result.modelName,
    compare,
  })
}
