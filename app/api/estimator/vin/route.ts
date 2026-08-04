import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { validateVIN, normalizeVIN, decodeVINFromNHTSA } from '@/apps/vehicle-entry/vin'
import { logger } from '@/platform/logger'

export const dynamic = 'force-dynamic'

const LOG = 'api:estimator:vin'

async function extractVINFromImage(image: File): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')

  const bytes  = await image.arrayBuffer()
  const base64 = Buffer.from(bytes).toString('base64')
  const mime   = image.type || 'image/jpeg'

  const client = new OpenAI({ apiKey })
  const response = await client.chat.completions.create({
    model:       'gpt-4.1',
    max_tokens:  32,
    temperature: 0,
    messages: [{
      role:    'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
        { type: 'text', text: 'Extract the 17-character Vehicle Identification Number (VIN) from this image. Return ONLY the 17 characters — no spaces, no punctuation, no other text. The letters I, O, and Q never appear in a VIN. If the VIN is not clearly readable, return the word null.' },
      ],
    }],
  })

  const content = (response.choices[0]?.message?.content ?? '').trim().replace(/\s/g, '')
  if (content.toLowerCase() === 'null' || content.length !== 17) return null
  return content.toUpperCase()
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''
  let rawVIN: string

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const image    = formData.get('vinImage') as File | null
    if (!image) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 })
    }

    logger.info(LOG, 'vin.photo.start', { bytes: image.size })

    let extracted: string | null
    try {
      extracted = await extractVINFromImage(image)
    } catch (err) {
      logger.error(LOG, 'vin.photo.ai.failed', { error: String(err) })
      return NextResponse.json(
        { error: 'Could not read VIN from photo — try better lighting or type the VIN manually' },
        { status: 422 }
      )
    }

    if (!extracted) {
      return NextResponse.json(
        { error: 'VIN not visible in photo — try holding the camera steady or type it manually' },
        { status: 422 }
      )
    }

    rawVIN = extracted
    logger.info(LOG, 'vin.photo.extracted', { vin: rawVIN })

  } else {
    const body = await request.json().catch(() => ({})) as { vin?: string }
    if (!body.vin) return NextResponse.json({ error: 'Missing vin' }, { status: 400 })
    rawVIN = body.vin
  }

  const candidate = normalizeVIN(rawVIN)
  const { valid, error } = validateVIN(rawVIN)
  if (!valid) {
    // Never discard the candidate VIN solely because validation (e.g. check digit)
    // failed — return it so the employee can review/correct it in an editable field.
    // `error` (technical detail) is kept for logs/audit only; the client shows `message`.
    logger.info(LOG, 'vin.invalid', { vin: candidate, reason: error })
    return NextResponse.json({
      vin:     candidate,
      valid:   false,
      year:    null, make: null, model: null, bodyClass: null,
      message: 'We may have misread one or more characters. Review and correct the VIN.',
    }, { status: 200 })
  }

  const vin = candidate
  logger.info(LOG, 'vin.decode.start', { vin })

  try {
    const decoded = await decodeVINFromNHTSA(vin)
    logger.info(LOG, 'vin.decode.complete', { vin, year: decoded.year, make: decoded.make, bodyClass: decoded.bodyClass })
    return NextResponse.json({
      vin:       decoded.vin,
      valid:     true,
      year:      decoded.year,
      make:      decoded.make,
      model:     decoded.model,
      bodyClass: decoded.bodyClass,
    })
  } catch (err) {
    logger.error(LOG, 'vin.decode.failed', { vin, error: String(err) })
    return NextResponse.json(
      { error: 'VIN lookup service unavailable — try again or enter vehicle details manually' },
      { status: 502 }
    )
  }
}
