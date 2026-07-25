import { NextResponse } from 'next/server'
import { validateVIN, normalizeVIN, decodeVINFromNHTSA } from '@/apps/vehicle-entry/vin'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'

async function extractVINFromImage(image: File): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')

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

async function decodeRawVIN(rawVIN: string) {
  const { valid, error } = validateVIN(rawVIN)
  if (!valid) return { error, status: 422 }

  const vin     = normalizeVIN(rawVIN)
  const decoded = await decodeVINFromNHTSA(vin)
  return {
    data: {
      vin:       decoded.vin,
      year:      decoded.year,
      make:      decoded.make,
      model:     decoded.model,
      bodyClass: decoded.bodyClass,
    }
  }
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') ?? ''

    // ── Image OCR path ────────────────────────────────────────────────────────
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const image    = formData.get('vinImage') as File | null
      if (!image) return NextResponse.json({ error: 'No image provided' }, { status: 400 })

      let extracted: string | null
      try {
        extracted = await extractVINFromImage(image)
      } catch {
        return NextResponse.json(
          { error: 'Could not read VIN from photo — try better lighting or type the VIN manually' },
          { status: 422 }
        )
      }

      if (!extracted) {
        return NextResponse.json(
          { error: 'VIN not visible in photo — aim at the barcode or printed VIN and try again' },
          { status: 422 }
        )
      }

      const result = await decodeRawVIN(extracted)
      if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
      return NextResponse.json(result.data)
    }

    // ── Text VIN path ─────────────────────────────────────────────────────────
    const body = await request.json() as { vin?: string }
    if (!body.vin) return NextResponse.json({ error: 'Missing vin' }, { status: 400 })

    const result = await decodeRawVIN(body.vin)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.data)

  } catch {
    return NextResponse.json(
      { error: 'VIN lookup unavailable — enter vehicle details manually' },
      { status: 502 }
    )
  }
}
