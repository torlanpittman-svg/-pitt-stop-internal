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

// Supported color values — must match COLORS in vehicle-data.ts exactly
const SUPPORTED_COLORS = [
  'Black', 'White', 'Silver', 'Gray', 'Red', 'Blue',
  'Green', 'Brown', 'Tan', 'Gold', 'Orange', 'Yellow', 'Purple',
]

const EXTRACTION_PROMPT = `
You are reading a photograph of a handwritten Pitt Stop dealership vehicle key tag.
Your only job is to extract five fields. This is NOT generic OCR — these tags are
handwritten by service writers, often in marker, and may be faded, smudged, or abbreviated.

FIELDS TO EXTRACT:
  year        — Vehicle model year (4-digit)
  make        — Manufacturer name
  model       — Vehicle model name
  color       — Exterior color
  stockNumber — Dealership stock number

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

STOCK NUMBER
• This is the most important field. It identifies the specific vehicle.
• Copy it EXACTLY as written — every character, digit, letter, dash, and space.
• Do NOT correct spelling, reformat, add dashes, or guess missing characters.
• If only partially readable, return what you can read and lower confidence.
• If completely unreadable, return null.

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
  "year":        "2019",
  "make":        "Chevrolet",
  "model":       "Silverado",
  "color":       "Black",
  "stockNumber": "PS-1234",
  "confidence": {
    "year":        95,
    "make":        88,
    "model":       72,
    "color":       91,
    "stockNumber": 65
  },
  "reasoning": {
    "model":       "Tag reads 'Silverdo' — likely Silverado but one letter unclear.",
    "stockNumber": "Third digit smudged, could be PS-1234 or PS-1284."
  }
}
`.trim()

type FieldKey = 'year' | 'make' | 'model' | 'color' | 'stockNumber'

interface RawOCRJson {
  year?:        string | null
  make?:        string | null
  model?:       string | null
  color?:       string | null
  stockNumber?: string | null
  // Confidence is 0–100 integers in the prompt; we convert to 0.0–1.0 for storage
  confidence?:  Partial<Record<FieldKey, number>>
  // Reasoning notes for fields below 80 confidence
  reasoning?:   Partial<Record<FieldKey, string>>
}

const FIELDS: FieldKey[] = ['year', 'make', 'model', 'color', 'stockNumber']

// Confidence threshold below which we treat a returned value as a non-answer.
// Prompt says "return null for confidence < 40", but this is a defensive backstop.
const NULL_BELOW_CONFIDENCE = 40

function parseResponse(
  content: string,
  rawResponse: unknown,
  providerName: string
): VehicleOCRResult {
  let parsed: RawOCRJson = {}
  try {
    // Strip accidental markdown fences the model might add despite instructions
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    parsed = JSON.parse(cleaned) as RawOCRJson
  } catch {
    // Parse failure → all fields null, zero confidence
  }

  // Convert 0–100 → 0.0–1.0 for all confidence values
  const conf: Record<FieldKey, number> = {} as Record<FieldKey, number>
  for (const f of FIELDS) {
    const raw = parsed.confidence?.[f]
    conf[f] = typeof raw === 'number' ? raw / 100 : 0
  }

  // Apply null-below-threshold: if the model returned a value but confidence
  // is too low, discard the value rather than mislead the employee.
  function fieldValue(f: FieldKey): string | null {
    const val = parsed[f] ?? null
    if (val === null) return null
    if ((conf[f] * 100) < NULL_BELOW_CONFIDENCE) return null
    return val
  }

  return {
    year:        fieldValue('year'),
    make:        fieldValue('make'),
    model:       fieldValue('model'),
    color:       fieldValue('color'),
    stockNumber: fieldValue('stockNumber'),
    confidence:  conf,
    // Store parsed JSON (including reasoning) as the raw response so the
    // admin panel can show it without any additional plumbing.
    rawResponse: parsed.reasoning
      ? { ...( rawResponse as object ), reasoning: parsed.reasoning }
      : rawResponse,
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
