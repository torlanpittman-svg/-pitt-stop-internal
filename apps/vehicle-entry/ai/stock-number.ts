/**
 * Stock number extraction — full-image-first pipeline.
 *
 * Phase 1 (parallel):
 *   A. Full-image extraction  — always the baseline
 *   B. Region detection       — returns a bounding box
 *
 * Phase 2 (if box is valid):
 *   C. Pad box 30% on each side
 *   D. Crop to padded box
 *   E. Crop extraction        — secondary attempt
 *   F. Debug overlay          — original image with both boxes drawn
 *
 * Winner selection:
 *   Use crop result ONLY when:
 *     - the box was valid (not full-image fallback, not too small)
 *     - the crop returned a non-null result
 *     - crop confidence strictly exceeds full-image confidence
 *   Otherwise the full-image result is used unchanged.
 */

import OpenAI from 'openai'
import { cropToBase64, padBox, isValidBox, drawBoxOverlay } from '@/platform/image-crop'
import type { BoundingBox } from '@/platform/image-crop'

const MODEL = 'gpt-4.1'

// ── Prompts ───────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `
This is a Pitt Stop dealership vehicle key tag. Extract the stock number.

Rules — copy the value EXACTLY as written:
- Include every character: letters, digits, dashes, leading zeros
- Never normalize, reformat, or reorder
- Never insert or remove spaces, dashes, or other punctuation
- Never guess or infer characters that are not clearly legible
- Return null if any character is uncertain

Return ONLY JSON, nothing else:
{"stockNumber": "PS1234", "confidence": 95}

confidence is 0–100. Return null for stockNumber if confidence would be below 80.
`.trim()

const DETECTION_PROMPT = `
Look at this Pitt Stop vehicle key tag photo.
Locate the field that contains the stock number — it may be labeled "Stock", "Stock #", "S#", "Stk", or similar, and contains an alphanumeric stock number written by hand.

Return ONLY a JSON bounding box as proportions of the total image size (0.0 to 1.0).
Include the field label AND the handwritten value. Give the box some margin.

Example: {"left": 0.05, "top": 0.62, "right": 0.80, "bottom": 0.84}

If you cannot confidently locate the stock number field, return:
{"left": 0, "top": 0, "right": 1, "bottom": 1}
`.trim()

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StockDebugData {
  source: 'full-image' | 'crop' | 'fallback'
  fullImagePrediction: string | null
  fullImageConfidence: number
  cropPrediction: string | null
  cropConfidence: number
  rawDetectionBox: BoundingBox | null
  paddedBox: BoundingBox | null
  boxValid: boolean
}

export interface StockNumberResult {
  stockNumber: string | null
  confidence: number                  // 0.0–1.0 — from whichever source won
  source: 'full-image' | 'crop' | 'fallback'
  fullImagePrediction: string | null
  fullImageConfidence: number
  cropPrediction: string | null
  cropConfidence: number
  cropBase64: string | null           // padded crop (null if box invalid)
  cropMimeType: 'image/jpeg'
  rawDetectionBox: BoundingBox | null
  paddedBox: BoundingBox | null
  boxValid: boolean
  debugOverlayBase64: string | null   // original image with boxes drawn
  debugData: StockDebugData
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set')
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

async function extractFromImage(
  base64: string,
  mimeType: string
): Promise<{ stockNumber: string | null; confidence: number }> {
  const client = getClient()
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 64,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
        { type: 'text', text: EXTRACTION_PROMPT },
      ],
    }],
  })
  const content = response.choices[0]?.message?.content ?? ''
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const parsed = JSON.parse(cleaned) as { stockNumber?: string | null; confidence?: number }
  const rawConf = typeof parsed.confidence === 'number' ? parsed.confidence : 0
  return {
    stockNumber: parsed.stockNumber && rawConf >= 80 ? parsed.stockNumber : null,
    confidence:  rawConf / 100,
  }
}

async function detectRegion(base64: string, mimeType: string): Promise<BoundingBox | null> {
  try {
    const client = getClient()
    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 64,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
          { type: 'text', text: DETECTION_PROMPT },
        ],
      }],
    })
    const content = response.choices[0]?.message?.content ?? ''
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const box = JSON.parse(cleaned) as Partial<BoundingBox>
    if (
      typeof box.left === 'number' && typeof box.top    === 'number' &&
      typeof box.right === 'number' && typeof box.bottom === 'number'
    ) {
      return box as BoundingBox
    }
  } catch {
    // Detection failed
  }
  return null
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function extractStockNumber(
  imageBase64: string,
  mimeType: string
): Promise<StockNumberResult> {

  // Phase 1: full-image extraction + detection run in parallel
  const [fullImageResult, rawDetectionBox] = await Promise.all([
    extractFromImage(imageBase64, mimeType).catch(() => ({ stockNumber: null, confidence: 0 })),
    detectRegion(imageBase64, mimeType),
  ])

  const boxValid    = rawDetectionBox !== null && isValidBox(rawDetectionBox)
  const paddedBox   = boxValid ? padBox(rawDetectionBox!, 0.30) : null

  let cropBase64:    string | null = null
  let cropPrediction: string | null = null
  let cropConfidence  = 0

  // Phase 2: crop pass (only if box is valid)
  if (boxValid && paddedBox) {
    try {
      const { base64: cropped } = await cropToBase64(imageBase64, paddedBox)
      cropBase64 = cropped
      const cropResult = await extractFromImage(cropped, 'image/jpeg')
      cropPrediction = cropResult.stockNumber
      cropConfidence  = cropResult.confidence
    } catch {
      // Crop pass failed — fall through to full-image result
    }
  }

  // Debug overlay — draw raw box (yellow dashed) + padded box (red solid)
  const debugOverlayBase64 = await drawBoxOverlay(imageBase64, rawDetectionBox, paddedBox)

  // Winner selection: crop only wins if it found something AND beats full-image
  const useCrop =
    boxValid &&
    cropPrediction !== null &&
    cropConfidence > fullImageResult.confidence

  const source: StockNumberResult['source'] = useCrop
    ? 'crop'
    : fullImageResult.stockNumber !== null
      ? 'full-image'
      : 'fallback'

  const stockNumber = useCrop ? cropPrediction : fullImageResult.stockNumber
  const confidence  = useCrop ? cropConfidence  : fullImageResult.confidence

  const debugData: StockDebugData = {
    source,
    fullImagePrediction: fullImageResult.stockNumber,
    fullImageConfidence: fullImageResult.confidence,
    cropPrediction,
    cropConfidence,
    rawDetectionBox,
    paddedBox,
    boxValid,
  }

  return {
    stockNumber,
    confidence,
    source,
    fullImagePrediction: fullImageResult.stockNumber,
    fullImageConfidence: fullImageResult.confidence,
    cropPrediction,
    cropConfidence,
    cropBase64,
    cropMimeType: 'image/jpeg',
    rawDetectionBox,
    paddedBox,
    boxValid,
    debugOverlayBase64,
    debugData,
  }
}
