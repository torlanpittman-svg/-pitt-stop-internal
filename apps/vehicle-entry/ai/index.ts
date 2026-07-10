/**
 * Vehicle Entry — AI extraction layer.
 *
 * This file owns:
 *   - the VE-specific extraction prompt
 *   - parsing the AI response into VehicleOCRResult
 *
 * It delegates the actual API call to platform/ai (provider-agnostic).
 * To swap providers: set OCR_PROVIDER env var.
 * To change what's extracted: edit EXTRACTION_PROMPT below.
 */

import { queryVision } from '@/platform/ai'
import type { VehicleOCRResult } from '../types'

const EXTRACTION_PROMPT = `
You are reading a handwritten vehicle key tag. Extract exactly these five fields.
Return ONLY a valid JSON object with this exact structure — no markdown, no explanation:

{
  "year": "4-digit year or null",
  "make": "manufacturer name or null",
  "model": "model name or null",
  "color": "color or null",
  "stockNumber": "stock number or null",
  "confidence": {
    "year": 0.0,
    "make": 0.0,
    "model": 0.0,
    "color": 0.0,
    "stockNumber": 0.0
  }
}

Rules:
- Return null for any field you cannot read clearly. Never guess.
- year must be a 4-digit year between 1990 and 2030, or null.
- Confidence is 0.0 (cannot read) to 1.0 (completely certain) per field.
- Return ONLY the JSON object. Nothing else.
`.trim()

interface RawOCRJson {
  year?: string | null
  make?: string | null
  model?: string | null
  color?: string | null
  stockNumber?: string | null
  confidence?: Partial<Record<'year' | 'make' | 'model' | 'color' | 'stockNumber', number>>
}

function parseResponse(
  content: string,
  rawResponse: unknown,
  providerName: string
): VehicleOCRResult {
  let parsed: RawOCRJson = {}
  try {
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    parsed = JSON.parse(cleaned) as RawOCRJson
  } catch {
    // Parse failure → all fields null, zero confidence
  }

  return {
    year:        parsed.year        ?? null,
    make:        parsed.make        ?? null,
    model:       parsed.model       ?? null,
    color:       parsed.color       ?? null,
    stockNumber: parsed.stockNumber ?? null,
    confidence: {
      year:        parsed.confidence?.year        ?? 0,
      make:        parsed.confidence?.make        ?? 0,
      model:       parsed.confidence?.model       ?? 0,
      color:       parsed.confidence?.color       ?? 0,
      stockNumber: parsed.confidence?.stockNumber ?? 0,
    },
    rawResponse,
    providerName,
  }
}

export async function extractVehicleData(
  imageBase64: string,
  mimeType: string
): Promise<VehicleOCRResult> {
  const { content, rawResponse, providerName } = await queryVision({
    imageBase64,
    mimeType,
    prompt: EXTRACTION_PROMPT,
  })
  return parseResponse(content, rawResponse, providerName)
}
