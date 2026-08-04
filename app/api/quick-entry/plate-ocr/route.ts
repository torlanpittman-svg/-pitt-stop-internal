/**
 * POST /api/quick-entry/plate-ocr  (multipart: plateImage)
 *
 * Reads the license-plate characters from a photo so the employee can snap the
 * plate instead of typing it. Returns { plate }. The employee still selects the
 * state and taps "Look Up Vehicle" — this never performs a lookup itself.
 */
import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { isPlateLookupEnabled, normalizePlate } from '@/apps/quick-entry/plate-lookup'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LOG = 'api:quick-entry:plate-ocr'

export async function POST(request: Request) {
  if (!isPlateLookupEnabled()) {
    return NextResponse.json({ ok: false, error: 'Plate lookup is not enabled.' }, { status: 503 })
  }
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'OCR is not configured.' }, { status: 503 })

  const form = await request.formData()
  const image = form.get('plateImage') as File | null
  if (!image) return NextResponse.json({ ok: false, error: 'No image provided.' }, { status: 400 })

  try {
    const base64 = Buffer.from(await image.arrayBuffer()).toString('base64')
    const mime = image.type || 'image/jpeg'
    const client = new OpenAI({ apiKey })
    const response = await client.chat.completions.create({
      model: 'gpt-4.1', max_tokens: 16, temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
          { type: 'text', text: 'Read the license plate number in this image. Return ONLY the plate characters (letters and numbers), no state name, no spaces, no dashes, no other text. If not clearly readable, return the word null.' },
        ],
      }],
    })
    const raw = (response.choices[0]?.message?.content ?? '').trim()
    const plate = normalizePlate(raw)
    if (raw.toLowerCase() === 'null' || plate.length < 2 || plate.length > 10) {
      return NextResponse.json({ ok: false, error: 'Could not read the plate — try again or type it.' })
    }
    logger.info(LOG, 'plate.ocr.ok', { len: plate.length })
    return NextResponse.json({ ok: true, plate })
  } catch (err) {
    logger.error(LOG, 'plate.ocr.failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: 'Could not read the plate — try again or type it.' }, { status: 422 })
  }
}
