import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { validateVIN, normalizeVIN, decodeVINFromNHTSA } from '@/apps/vehicle-entry/vin'
import { logger } from '@/platform/logger'

const LOG = 'api:vehicle-entry:vin'

async function extractVINFromImage(image: File): Promise<string | null> {
  const bytes  = await image.arrayBuffer()
  const base64 = Buffer.from(bytes).toString('base64')
  const mime   = image.type || 'image/jpeg'

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
  const response = await client.chat.completions.create({
    model:      'gpt-4.1',
    max_tokens: 32,
    temperature: 0,
    messages: [{
      role:    'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
        { type: 'text', text: 'Extract the 17-character Vehicle Identification Number (VIN) from this image. Return ONLY the 17 characters — no spaces, no other text. The letters I, O, and Q never appear in VINs. If the VIN is not clearly readable, return null.' },
      ],
    }],
  })

  const content = (response.choices[0]?.message?.content ?? '').trim()
  if (content.toLowerCase() === 'null' || content.length !== 17) return null
  return content.toUpperCase()
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''
  let rawVIN: string

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const image    = formData.get('vinImage') as File | null
    if (!image) return NextResponse.json({ error: 'No image provided' }, { status: 400 })

    logger.info(LOG, 'vin.photo.start', { bytes: image.size })

    let extracted: string | null
    try {
      extracted = await extractVINFromImage(image)
    } catch (err) {
      logger.error(LOG, 'vin.photo.ai.failed', { error: String(err) })
      return NextResponse.json(
        { error: 'Could not read VIN from photo — try typing it manually' },
        { status: 422 }
      )
    }

    if (!extracted) {
      return NextResponse.json(
        { error: 'VIN not visible in photo — try better lighting or type it manually' },
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

  const { valid, error } = validateVIN(rawVIN)
  if (!valid) return NextResponse.json({ error }, { status: 422 })

  const vin = normalizeVIN(rawVIN)
  logger.info(LOG, 'vin.decode.start', { vin })

  try {
    const decoded = await decodeVINFromNHTSA(vin)
    logger.info(LOG, 'vin.decode.complete', { vin, year: decoded.year, make: decoded.make })
    return NextResponse.json(decoded)
  } catch (err) {
    logger.error(LOG, 'vin.decode.failed', { vin, error: String(err) })
    return NextResponse.json(
      { error: 'VIN lookup service unavailable — try again in a moment' },
      { status: 502 }
    )
  }
}
