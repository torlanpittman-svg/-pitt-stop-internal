/**
 * Vehicle Entry — AI extraction layer.
 *
 * Runs two pipelines in parallel:
 *   1. General extraction (year, make, model, color) via the platform vision layer
 *   2. Dedicated stock number pipeline (detect region → crop → extract)
 *
 * Stock number is kept separate because it is the highest-priority field and
 * requires exact character-level accuracy.
 */

import { queryVision } from '@/platform/ai'
import { extractStockNumber } from './stock-number'
import type { VehicleOCRResult } from '../types'

// Increment when the EXTRACTION_PROMPT changes so re-runs can be compared.
export const EXTRACTION_PROMPT_VERSION = 'v1'

// Supported color values — must match COLORS in vehicle-data.ts exactly
const SUPPORTED_COLORS = [
  'Black', 'White', 'Silver', 'Gray', 'Red', 'Blue',
  'Green', 'Brown', 'Tan', 'Gold', 'Orange', 'Yellow', 'Purple',
]

const EXTRACTION_PROMPT = `
You are reading a photograph of a handwritten Pitt Stop dealership vehicle key tag.
Extract four fields. Ignore the stock number — it is handled separately.

FIELDS TO EXTRACT:
  year   — Vehicle model year (4-digit)
  make   — Manufacturer name
  model  — Vehicle model name
  color  — Exterior color

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIELD RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YEAR
• Must be a 4-digit year between 1990 and 2030, or null.
• Writers sometimes abbreviate (e.g. "19" for 2019, "22" for 2022).
  Expand only if you are certain of the decade — otherwise return null.
• If not clearly readable, return null.

MAKE
• Normalize abbreviations and nicknames to official manufacturer names:
    Chevy / Chev         → Chevrolet
    VW                   → Volkswagen
    Merc / MB            → Mercedes-Benz
    Land Rover           → Land Rover (keep as-is)
• Never use slang, shorthand, or unofficial names in the returned value.
• If not clearly readable, return null.

MODEL
• Return the model name with standard capitalization (e.g. "Silverado", "F-150").
• Only return a value if confidence is 60 or higher.
• If the handwriting is ambiguous between two models, return null.
• If not readable, return null.

COLOR
• Prefer one of these exact supported values (match case exactly):
    ${SUPPORTED_COLORS.join(', ')}
• If the written color matches one above, return that exact string.
• If it does not match (e.g. "Maroon", "Burgundy", "Beige"), return "Other"
  and explain the raw text in the reasoning field.
• If not readable, return null.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONFIDENCE (integer 0–100 per field)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 100 = perfectly legible, no ambiguity
  80 = clearly readable, minor uncertainty
  60 = probably correct, handwriting is difficult
  40 = uncertain, human must verify
 < 40 = return null instead of a guess

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REASONING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For every field with confidence below 80, include a short note in the "reasoning"
object explaining why (e.g. "last digit smudged", "could be Silverado or Sierra").
Omit reasoning for fields at 80 or above.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT — STRICT JSON ONLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return ONLY a valid JSON object. No markdown, no code fences, no explanation.

{
  "year":  "2019",
  "make":  "Chevrolet",
  "model": "Silverado",
  "color": "Black",
  "confidence": {
    "year":  95,
    "make":  88,
    "model": 72,
    "color": 91
  },
  "reasoning": {
    "model": "Tag reads 'Silverdo' — likely Silverado but one letter unclear."
  }
}
`.trim()

type FieldKey = 'year' | 'make' | 'model' | 'color'

interface RawOCRJson {
  year?:    string | null
  make?:    string | null
  model?:   string | null
  color?:   string | null
  confidence?: Partial<Record<FieldKey, number>>
  reasoning?:  Partial<Record<FieldKey, string>>
}

const FIELDS: FieldKey[] = ['year', 'make', 'model', 'color']

const NULL_BELOW_CONFIDENCE = 40

function parseResponse(
  content: string,
  rawResponse: unknown,
  providerName: string
): Omit<VehicleOCRResult, 'stockNumber' | 'stockCropBase64' | 'stockCropMimeType' | 'modelName' | 'promptVersion'> {
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

  // stockNumber is handled by the dedicated pipeline; default to 0 here
  const conf = { year: 0, make: 0, model: 0, color: 0, stockNumber: 0 }
  for (const f of FIELDS) {
    const raw = parsed.confidence?.[f]
    conf[f] = typeof raw === 'number' ? raw / 100 : 0
  }

  function fieldValue(f: FieldKey): string | null {
    const val = parsed[f] ?? null
    if (val === null) return null
    if ((conf[f] * 100) < NULL_BELOW_CONFIDENCE) return null
    return val
  }

  return {
    year:    fieldValue('year'),
    make:    fieldValue('make'),
    model:   fieldValue('model'),
    color:   fieldValue('color'),
    confidence: conf,
    rawResponse: parsed.reasoning
      ? { ...(rawResponse as object), reasoning: parsed.reasoning }
      : rawResponse,
    providerName,
    // Filled in by extractVehicleData after the stock pipeline runs
    stockDebugOverlayBase64: null,
    stockDebugData:          null,
  }
}

export async function extractVehicleData(
  imageBase64: string,
  mimeType: string
): Promise<VehicleOCRResult> {
  const [visionResult, stockResult] = await Promise.all([
    queryVision({ imageBase64, mimeType, prompt: EXTRACTION_PROMPT }),
    extractStockNumber(imageBase64, mimeType),
  ])

  const base = parseResponse(visionResult.content, visionResult.rawResponse, visionResult.providerName)

  return {
    ...base,
    modelName:     visionResult.modelName,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    stockNumber: stockResult.stockNumber,
    confidence: {
      ...base.confidence,
      stockNumber: stockResult.confidence,
    },
    stockCropBase64:          stockResult.cropBase64,
    stockCropMimeType:        stockResult.cropMimeType,
    stockDebugOverlayBase64:  stockResult.debugOverlayBase64,
    stockDebugData:           stockResult.debugData as unknown as Record<string, unknown>,
  }
}
