/**
 * Retail Estimator — AI vision analysis module.
 *
 * Sends all vehicle photos to GPT-4o in a single request and returns a
 * structured assessment with findings, labor minutes, and recommended price.
 *
 * To swap prompt versions: bump ESTIMATOR_PROMPT_VERSION, update buildPrompt(),
 * and redeploy. The route and review screen never need to change.
 *
 * Provider: OpenAI GPT-4o (set OPENAI_API_KEY in environment).
 * Fallback: dev mock when OPENAI_API_KEY is absent.
 */

import OpenAI from 'openai'
import type { EstimatePhotoRow } from '../db'

export const ESTIMATOR_PROMPT_VERSION = 'v4'

// Mirrors estimator_config seed values from the PRD.
// $95/hr target rate × 2.2× markup = recommended selling price from labor.
const TARGET_HOURLY_RATE_CENTS = 9_500
const MARKUP_MULTIPLIER = 2.2

// ── Types ─────────────────────────────────────────────────────────────────────

export type AiDifficultyRating = 'routine' | 'moderate' | 'demanding' | 'time_trap'
export type AiSeverity         = 'light' | 'moderate' | 'heavy' | 'severe'
export type AiLaborImpact      = 'low' | 'medium' | 'high' | 'extreme'
export type AiCategory         = 'time_trap' | 'interior' | 'exterior' | 'glass' | 'wheels' | 'other'

export interface AiFinding {
  id:           string
  category:     AiCategory
  location:     string
  damageType:   string
  severity:     AiSeverity
  laborImpact:  AiLaborImpact
  description:  string
  serviceCode:  string
  laborMinutes: number
  confidence:   number
  isTimeTrap:   boolean
}

export interface AiVehicle {
  year:             string | null
  make:             string | null
  model:            string | null
  color:            string | null
  size:             string | null
  valueTier:        string | null
  hasThirdRow:      boolean
  difficultyRating: AiDifficultyRating
}

export interface AiAnalysisResult {
  vehicle:               AiVehicle
  findings:              AiFinding[]
  totalLaborMinutes:     number
  recommendedPriceCents: number
  notes:                 string | null
  rawResponse:           unknown
  modelName:             string
  promptVersion:         string
  durationMs:            number
  inputTokens:           number | null
  outputTokens:          number | null
}

// ── Accepted service codes ─────────────────────────────────────────────────────
// AI output is rejected if it uses a code not in this set; falls back to 'custom'.

const VALID_SERVICE_CODES = new Set([
  'interior_basic', 'interior_full', 'interior_deep',
  'exterior_wash', 'exterior_wash_wax', 'exterior_full',
  'full_detail_basic', 'full_detail_standard', 'full_detail_premium',
  'paint_correction_one', 'paint_correction_two', 'paint_correction_three',
  'ceramic_coat_basic', 'ceramic_coat_pro',
  'ppf_partial', 'ppf_full_front', 'ppf_full_vehicle',
  'wheel_clean_full', 'wheel_refinish', 'windshield_chip',
  'pet_hair_removal', 'odor_treatment', 'sand_removal',
  'smoke_treatment', 'scratch_buff', 'dent_repair_pdr',
  'water_spot_removal', 'paint_decontamination', 'custom',
])

// ── Prompt ─────────────────────────────────────────────────────────────────────

function buildPrompt(serviceFocus: string | null): string {
  const focusNote = serviceFocus
    ? `The customer has requested: ${serviceFocus.replace(/_/g, ' ')}. Prioritize findings relevant to this service, but surface all visible conditions regardless.`
    : 'No specific service has been requested. Surface all visible conditions.'

  return `You are a professional auto detailing and repair estimator for Pitt Stop.
You receive multiple photos of a single vehicle and produce a structured condition assessment.

Your role is NOT to describe what you see in general terms.
Your role is to identify business-relevant findings with labor consequences, time traps, difficulty ratings, and recommended services.

${focusNote}

CRITICAL RULES:
1. Your FIRST finding (id "f0") must always be the base service finding. See BASE SERVICE LABOR below.
2. Every subsequent finding adds incremental labor ON TOP of the base — do not re-include base time.
3. Time traps (heavy pet hair, smoke or odor saturation, beach sand, mold, glitter, biohazard, vomit) must have category "time_trap" and isTimeTrap: true.
4. Never return a dollar amount. Prices are calculated separately from your output.
5. Use only the service codes listed below. Use "custom" if no code fits.
6. Return ONLY valid JSON — no markdown fences, no code blocks, no explanatory text.
7. Name the specific material type for every soiling finding — never use vague terms like "dirt and debris." Write exactly what it is: red clay soil, beach sand, food crumbs, organic mulch, pet hair, liquid spill, etc.
8. Floor areas are separate findings: front floor (driver + passenger together), rear floor (second row), and third-row/trunk are three distinct findings if soiled. Each gets its own laborMinutes.

BASE SERVICE LABOR:
Output one base finding (id "f0") that covers standard labor for this service on this vehicle size.
Set isTimeTrap: false, confidence: 1.0, category matching the service (interior/exterior/other), damageType: "base_service".
Use the serviceCode that matches the requested service:
  full_detail → full_detail_standard
  interior_only → interior_full
  exterior_only → exterior_full
  (if no service requested, use the most appropriate code)

Base laborMinutes by vehicle size and service:
  Size                         | interior_only | exterior_only | full_detail
  compact_car/coupe/sports_car |      75       |      60       |    135
  mid_size_sedan               |      90       |      60       |    150
  full_size_sedan/luxury_sedan |     105       |      75       |    180
  compact_suv                  |      90       |      60       |    150
  mid_size_suv/luxury_suv      |     105       |      75       |    180
  full_size_suv_2row/minivan   |     120       |      90       |    210
  full_size_suv_3row           |     150       |     105       |    255
  compact_pickup               |      90       |      75       |    165
  full_size_pickup_regular     |     105       |      90       |    195
  full_size_pickup_crew        |     120       |      90       |    210
  exotic/cargo_van             |     180       |     120       |    300
  unknown                      |     105       |      75       |    180

Description format: "Base [service name] — [vehicle size]" (e.g. "Base full detail — full-size 3-row SUV").

SERVICE CODES (use only these exact strings):
interior_basic, interior_full, interior_deep,
exterior_wash, exterior_wash_wax, exterior_full,
full_detail_basic, full_detail_standard, full_detail_premium,
paint_correction_one, paint_correction_two, paint_correction_three,
ceramic_coat_basic, ceramic_coat_pro,
ppf_partial, ppf_full_front, ppf_full_vehicle,
wheel_clean_full, wheel_refinish, windshield_chip,
pet_hair_removal, odor_treatment, sand_removal,  ← use for ALL granular/particulate debris: beach sand, clay soil, road grit, organic mulch, sawdust, gravel, construction dust
smoke_treatment, scratch_buff, dent_repair_pdr,
water_spot_removal, paint_decontamination, custom

CLASSIFICATION — reason about all three dimensions independently for every finding:

SEVERITY (visual/physical condition of the surface — what you see):
- light:    Minor, affects a small area, barely noticeable
- moderate: Clearly visible, covers a meaningful portion of the surface
- heavy:    Widespread or deeply embedded, covers or penetrates a significant area
- severe:   Extreme — degraded material, major damage, or critical defect requiring specialist assessment

LABOR IMPACT (how much this finding increases total job time — independent of severity):
- low:      Adds 0–15 minutes above base
- medium:   Adds 15–45 minutes above base
- high:     Adds 45–120 minutes above base
- extreme:  Adds 120+ minutes, or fundamentally changes job complexity

TIME TRAP — Boolean. Set to true ONLY when the finding requires specialty procedures,
specialty equipment not in a standard detail kit, unusual chemicals, multi-day processing,
or creates a major pricing exception the employee must know before quoting.

Time Trap = TRUE:
  heavy pet hair (specialty extraction tools required), smoke/odor saturation (ozone generator required),
  mold or mildew (antimicrobial treatment), vomit/blood/biohazard (decontamination protocol),
  rodent contamination, excessive embedded beach sand (multiple wet extraction cycles),
  heavy paint overspray (specialty clay and compounds), severe oxidation (multi-stage aggressive correction)

Time Trap = FALSE — even when labor impact is HIGH or EXTREME:
  organic mulch, leaves, normal dirt and road grit, food crumbs, routine carpet extraction,
  brake dust, water spots, light-moderate stains, standard leather cleaning,
  normal swirl marks, routine clay bar decontamination, standard odor (not saturation)

Key principle: a finding can have HIGH or EXTREME labor impact without being a time trap.
Time traps are about UNUSUAL PROCEDURES — not just a lot of work.

LABOR REFERENCE (incremental minutes added on top of base service):
Pet hair per seating row: light +10, moderate +35, heavy +75
Sand/clay/mulch in carpet — front floor: light +10, moderate +30, heavy +55
Sand/clay/mulch in carpet — rear floor: light +10, moderate +25, heavy +45
Sand/clay/mulch in carpet — trunk: light +5, moderate +15, heavy +25
Smoke saturation: +60–90 (ozone cycle required)
Odor treatment: light +20, moderate +35, heavy +60
Paint scratch per panel: light +10, moderate +30, heavy +60
Water spots on paint: light +10, moderate +25, heavy +45
Swirl marks (full vehicle): light +20, moderate +45, heavy +90
Brake dust on wheels (all 4): light +10, moderate +20, heavy +35
Leather seat soiling: light +5, moderate +15, heavy +30

DARK/BLACK PAINT NOTE:
If the vehicle has dark or black paint, swirl marks, water spots, and fine scratches may not be visible at photo resolution. Add a note for the employee to assess paint condition in person before finalizing the exterior findings.

FIELD CONSTRAINTS:
vehicle.size must be one of: compact_car, mid_size_sedan, full_size_sedan, coupe, compact_suv, mid_size_suv, full_size_suv_2row, full_size_suv_3row, minivan, compact_pickup, full_size_pickup_crew, full_size_pickup_regular, sports_car, luxury_sedan, luxury_suv, exotic, cargo_van, convertible, unknown
vehicle.valueTier must be one of: economy, mid-market, premium, luxury, exotic
vehicle.difficultyRating: routine (no time traps, clean vehicle), moderate (some soiling), demanding (multiple conditions), time_trap (at least one true time trap present)
finding.category must be one of: time_trap, interior, exterior, glass, wheels, other
finding.severity must be one of: light, moderate, heavy, severe
finding.laborImpact must be one of: low, medium, high, extreme
finding.confidence is a float from 0.0 to 1.0
finding.laborMinutes is an integer from 1 to 480
totalLaborMinutes is the sum of ALL finding.laborMinutes values including the base service finding

OUTPUT FORMAT (return exactly this structure):
{
  "vehicle": {
    "year": "2019",
    "make": "Chevrolet",
    "model": "Tahoe",
    "color": "Black",
    "size": "full_size_suv_3row",
    "valueTier": "mid-market",
    "hasThirdRow": true,
    "difficultyRating": "demanding"
  },
  "findings": [
    {
      "id": "f0",
      "category": "interior",
      "location": "full_vehicle",
      "damageType": "base_service",
      "severity": "light",
      "laborImpact": "high",
      "description": "Base full detail — full-size 3-row SUV",
      "serviceCode": "full_detail_standard",
      "laborMinutes": 255,
      "confidence": 1.0,
      "isTimeTrap": false
    },
    {
      "id": "f1",
      "category": "time_trap",
      "location": "interior_rear_seats",
      "damageType": "pet_hair",
      "severity": "heavy",
      "laborImpact": "high",
      "description": "Dense dog hair covering approximately 80% of rear seat fabric and visible on floor carpet. Multiple extraction passes required.",
      "serviceCode": "pet_hair_removal",
      "laborMinutes": 75,
      "confidence": 0.91,
      "isTimeTrap": true
    }
  ],
  "totalLaborMinutes": 330,
  "notes": "Black paint — employee should assess exterior paint condition in person before approving estimate."
}`
}

// ── OpenAI client ─────────────────────────────────────────────────────────────

let _client: OpenAI | null = null

function getOpenAIClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set')
  if (!_client) _client = new OpenAI({ apiKey: key })
  return _client
}

interface RawCallResult {
  content:      string
  modelName:    string
  inputTokens:  number | null
  outputTokens: number | null
}

async function callGPT4o(
  photos: EstimatePhotoRow[],
  prompt: string,
): Promise<RawCallResult> {
  const client = getOpenAIClient()

  type ImageBlock = { type: 'image_url'; image_url: { url: string; detail: 'high' } }
  type TextBlock  = { type: 'text'; text: string }

  const imageBlocks: ImageBlock[] = photos.map(p => ({
    type: 'image_url',
    image_url: { url: p.photoUrl, detail: 'high' },
  }))

  const response = await client.chat.completions.create({
    model:      'gpt-4o',
    max_tokens: 2048,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: prompt }] as (ImageBlock | TextBlock)[],
    }],
  })

  return {
    content:      response.choices[0]?.message?.content ?? '',
    modelName:    response.model,
    inputTokens:  response.usage?.prompt_tokens  ?? null,
    outputTokens: response.usage?.completion_tokens ?? null,
  }
}

// ── Response parsing & validation ─────────────────────────────────────────────

interface RawAiResponse {
  vehicle?: {
    year?:             string | null
    make?:             string | null
    model?:            string | null
    color?:            string | null
    size?:             string | null
    valueTier?:        string | null
    hasThirdRow?:      boolean
    difficultyRating?: string
  }
  findings?: Array<{
    id?:           string
    category?:     string
    location?:     string
    damageType?:   string
    severity?:     string
    laborImpact?:  string
    description?:  string
    serviceCode?:  string
    laborMinutes?: number
    confidence?:   number
    isTimeTrap?:   boolean
  }>
  totalLaborMinutes?: number
  notes?:             string | null
}

function parseJsonContent(raw: string): RawAiResponse {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  return JSON.parse(cleaned) as RawAiResponse
}

const VALID_CATEGORIES    = new Set(['time_trap', 'interior', 'exterior', 'glass', 'wheels', 'other'])
const VALID_SEVERITIES    = new Set(['light', 'moderate', 'heavy', 'severe'])
const VALID_LABOR_IMPACTS = new Set(['low', 'medium', 'high', 'extreme'])
const VALID_DIFFICULTIES  = new Set(['routine', 'moderate', 'demanding', 'time_trap'])

function sanitizeFinding(
  raw: NonNullable<RawAiResponse['findings']>[number],
  index: number,
): AiFinding {
  const category    = VALID_CATEGORIES.has(raw.category ?? '')    ? raw.category    as AiCategory    : 'other'
  const severity    = VALID_SEVERITIES.has(raw.severity ?? '')    ? raw.severity    as AiSeverity    : 'light'
  const laborImpact = VALID_LABOR_IMPACTS.has(raw.laborImpact ?? '') ? raw.laborImpact as AiLaborImpact : 'medium'
  const isTimeTrap  = raw.isTimeTrap === true
  const serviceCode = VALID_SERVICE_CODES.has(raw.serviceCode ?? '') ? raw.serviceCode! : 'custom'

  return {
    id:           raw.id ?? `f${index + 1}`,
    category,
    location:     (raw.location    ?? 'unknown').slice(0, 100),
    damageType:   (raw.damageType  ?? 'unknown').slice(0, 50),
    severity,
    laborImpact,
    description:  (raw.description ?? '').slice(0, 1000),
    serviceCode,
    laborMinutes: Math.min(480, Math.max(1, Math.round(raw.laborMinutes ?? 15))),
    confidence:   Math.min(1,   Math.max(0, raw.confidence ?? 0.5)),
    isTimeTrap,
  }
}

function buildResult(
  parsed:       RawAiResponse,
  rawResponse:  unknown,
  modelName:    string,
  promptVersion: string,
  durationMs:   number,
  inputTokens:  number | null,
  outputTokens: number | null,
): AiAnalysisResult {
  const findings = (parsed.findings ?? []).map((f, i) => sanitizeFinding(f, i))

  // Price per finding so line items and the estimate total are consistent
  const findingsWithPrice = findings.map(f => ({
    ...f,
    priceCents: Math.round((f.laborMinutes / 60) * TARGET_HOURLY_RATE_CENTS * MARKUP_MULTIPLIER),
  }))

  const totalLaborMinutes     = findings.reduce((s, f) => s + f.laborMinutes, 0)
  const recommendedPriceCents = findingsWithPrice.reduce((s, f) => s + f.priceCents, 0)
  const avgConfidence = findings.length > 0
    ? findings.reduce((s, f) => s + f.confidence, 0) / findings.length
    : null

  const difficultyRating = VALID_DIFFICULTIES.has(parsed.vehicle?.difficultyRating ?? '')
    ? parsed.vehicle!.difficultyRating as AiDifficultyRating
    : 'routine'

  console.log('[estimator:ai] analysis complete', JSON.stringify({
    promptVersion,
    model:            modelName,
    durationMs,
    inputTokens,
    outputTokens,
    findingCount:     findings.length,
    timeTrapCount:    findings.filter(f => f.isTimeTrap).length,
    totalLaborMinutes,
    recommendedPrice: `$${(recommendedPriceCents / 100).toFixed(2)}`,
    avgConfidence:    avgConfidence != null ? avgConfidence.toFixed(3) : 'n/a',
    difficultyRating,
  }))

  return {
    vehicle: {
      year:       parsed.vehicle?.year  ?? null,
      make:       parsed.vehicle?.make  ?? null,
      model:      parsed.vehicle?.model ?? null,
      color:      parsed.vehicle?.color ?? null,
      size:       parsed.vehicle?.size  ?? null,
      valueTier:  parsed.vehicle?.valueTier ?? null,
      hasThirdRow: parsed.vehicle?.hasThirdRow ?? false,
      difficultyRating,
    },
    findings,
    totalLaborMinutes,
    recommendedPriceCents,
    notes:        (parsed.notes ?? null),
    rawResponse,
    modelName,
    promptVersion,
    durationMs,
    inputTokens,
    outputTokens,
  }
}

// ── Dev mock ──────────────────────────────────────────────────────────────────
// Activated when OPENAI_API_KEY is absent. Returns realistic multi-finding
// output so the full employee UI flow is testable without an API key.

function buildDevMock(serviceFocus: string | null): AiAnalysisResult {
  console.log('[estimator:ai] OPENAI_API_KEY not set — returning dev mock (add key for real analysis)')

  const isExterior = serviceFocus === 'exterior_only'
  const isInterior = serviceFocus === 'interior_only'

  // Base service finding (f0) — always present
  const baseMinutes = isExterior ? 105 : isInterior ? 150 : 255
  const baseCode    = isExterior ? 'exterior_full' : isInterior ? 'interior_full' : 'full_detail_standard'
  const baseLabel   = isExterior ? 'exterior only' : isInterior ? 'interior only' : 'full detail'
  const findings: AiFinding[] = [{
    id: 'f0', category: 'interior', location: 'full_vehicle',
    damageType: 'base_service', severity: 'light', laborImpact: 'high',
    description: `Base ${baseLabel} — full-size 3-row SUV`,
    serviceCode: baseCode, laborMinutes: baseMinutes, confidence: 1.0, isTimeTrap: false,
  }]

  if (!isExterior) {
    findings.push({
      id: 'f1', category: 'time_trap', location: 'interior_rear_seats',
      damageType: 'pet_hair', severity: 'heavy', laborImpact: 'high',
      description: 'Dense dog hair covering approximately 70% of rear seat fabric and visible on the floor carpet. Multiple extraction passes required.',
      serviceCode: 'pet_hair_removal', laborMinutes: 65, confidence: 0.88, isTimeTrap: true,
    })
    findings.push({
      id: 'f2', category: 'interior', location: 'interior_floor_front',
      damageType: 'red_clay_soil', severity: 'heavy', laborImpact: 'high',
      description: 'Heavy red clay soil embedded in front floor mats and carpet pile on both driver and passenger sides. Extraction passes required.',
      serviceCode: 'sand_removal', laborMinutes: 55, confidence: 0.92, isTimeTrap: false,
    })
    findings.push({
      id: 'f3', category: 'interior', location: 'interior_console',
      damageType: 'cup_holder_residue', severity: 'light', laborImpact: 'low',
      description: 'Residue buildup in cup holders and around gear shift area. Solvent wipe will clear it.',
      serviceCode: 'interior_full', laborMinutes: 10, confidence: 0.85, isTimeTrap: false,
    })
  }

  if (!isInterior) {
    findings.push({
      id: 'f4', category: 'exterior', location: 'driver_door_panel',
      damageType: 'surface_scratch', severity: 'moderate', laborImpact: 'medium',
      description: 'Light surface scratches along the lower driver door panel, approximately 6 inches in length. No primer visible.',
      serviceCode: 'scratch_buff', laborMinutes: 30, confidence: 0.79, isTimeTrap: false,
    })
    findings.push({
      id: 'f5', category: 'exterior', location: 'exterior_paint_hood_roof',
      damageType: 'mineral_water_spots', severity: 'light', laborImpact: 'low',
      description: 'Water spot etching visible on hood and roof panels from mineral deposits. Light polish will remove.',
      serviceCode: 'water_spot_removal', laborMinutes: 20, confidence: 0.83, isTimeTrap: false,
    })
    findings.push({
      id: 'f6', category: 'wheels', location: 'all_four_wheels',
      damageType: 'brake_dust', severity: 'moderate', laborImpact: 'medium',
      description: 'Brake dust buildup on all four wheels, heaviest on front pair. Acid wheel cleaner and agitation required.',
      serviceCode: 'wheel_clean_full', laborMinutes: 20, confidence: 0.95, isTimeTrap: false,
    })
  }

  const totalLaborMinutes     = findings.reduce((s, f) => s + f.laborMinutes, 0)
  const recommendedPriceCents = findings.reduce((s, f) =>
    s + Math.round((f.laborMinutes / 60) * TARGET_HOURLY_RATE_CENTS * MARKUP_MULTIPLIER), 0)

  return {
    vehicle: {
      year: '2021', make: 'Toyota', model: 'Camry', color: 'Silver',
      size: 'mid_size_sedan', valueTier: 'mid-market',
      hasThirdRow: false, difficultyRating: 'demanding',
    },
    findings,
    totalLaborMinutes,
    recommendedPriceCents,
    notes: 'DEV MOCK — add OPENAI_API_KEY to .env.local for real AI analysis.',
    rawResponse: { mock: true, serviceFocus },
    modelName:    'mock',
    promptVersion: `${ESTIMATOR_PROMPT_VERSION}-mock`,
    durationMs:    0,
    inputTokens:   null,
    outputTokens:  null,
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runEstimatorAnalysis(
  photos:       EstimatePhotoRow[],
  serviceFocus: string | null,
): Promise<AiAnalysisResult> {
  if (!process.env.OPENAI_API_KEY) {
    return buildDevMock(serviceFocus)
  }

  const prompt    = buildPrompt(serviceFocus)
  const startedAt = Date.now()

  console.log('[estimator:ai] starting analysis', JSON.stringify({
    promptVersion: ESTIMATOR_PROMPT_VERSION,
    photoCount:    photos.length,
    serviceFocus,
    photoRoles:    photos.map(p => p.role),
  }))

  // First API call
  let callResult: RawCallResult
  try {
    callResult = await callGPT4o(photos, prompt)
  } catch (err) {
    throw new Error(`GPT-4o API call failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Parse — retry once with an explicit JSON-only instruction if first attempt fails
  let parsed: RawAiResponse
  try {
    parsed = parseJsonContent(callResult.content)
  } catch {
    console.warn('[estimator:ai] JSON parse failed on first attempt — retrying with explicit JSON instruction')
    try {
      const retry = await callGPT4o(
        photos,
        prompt + '\n\nReturn ONLY the JSON object. No text before or after. No markdown. Just the raw JSON.',
      )
      parsed      = parseJsonContent(retry.content)
      callResult  = retry
    } catch (retryErr) {
      const durationMs = Date.now() - startedAt
      console.error('[estimator:ai] JSON parse failed after retry:', retryErr)
      // Graceful degradation: return zero findings so employee can add manually
      return {
        vehicle: {
          year: null, make: null, model: null, color: null,
          size: null, valueTier: null, hasThirdRow: false, difficultyRating: 'routine',
        },
        findings:              [],
        totalLaborMinutes:     0,
        recommendedPriceCents: 0,
        notes: 'AI response could not be parsed. Please add findings manually.',
        rawResponse:  { error: 'parse_failed', raw: callResult.content },
        modelName:    callResult.modelName,
        promptVersion: `${ESTIMATOR_PROMPT_VERSION}-parse-error`,
        durationMs,
        inputTokens:  callResult.inputTokens,
        outputTokens: callResult.outputTokens,
      }
    }
  }

  const durationMs = Date.now() - startedAt
  return buildResult(
    parsed,
    callResult.content,
    callResult.modelName,
    ESTIMATOR_PROMPT_VERSION,
    durationMs,
    callResult.inputTokens,
    callResult.outputTokens,
  )
}

// Per-finding price helper — used by the analyze route so line item prices
// match the estimate-level recommendedPriceCents without rounding drift.
export function findingPriceCents(laborMinutes: number): number {
  return Math.round((laborMinutes / 60) * TARGET_HOURLY_RATE_CENTS * MARKUP_MULTIPLIER)
}
