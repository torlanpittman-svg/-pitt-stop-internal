/**
 * Standalone GPT-4o Vision test script.
 * Pulls real photos from an existing estimate and runs the AI analysis prompt,
 * showing the raw JSON response without touching any DB records.
 *
 * Usage: node test-ai.mjs <estimateId> [serviceFocus]
 */

import OpenAI from 'openai'
import { neon } from '@neondatabase/serverless'

const estimateId  = process.argv[2]
const serviceFocus = process.argv[3] ?? null

if (!estimateId) {
  console.error('Usage: node test-ai.mjs <estimateId> [serviceFocus]')
  process.exit(1)
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set')
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Prompt (copied from apps/estimator/ai/index.ts) ───────────────────────────
function buildPrompt(serviceFocus) {
  const focusNote = serviceFocus
    ? `The customer has requested: ${serviceFocus.replace(/_/g, ' ')}. Prioritize findings relevant to this service, but surface all visible conditions regardless.`
    : 'No specific service has been requested. Surface all visible conditions.'

  return `You are a professional auto detailing and repair estimator for Pitt Stop.
You receive multiple photos of a single vehicle and produce a structured condition assessment.

Your role is NOT to describe what you see in general terms.
Your role is to identify business-relevant findings with labor consequences, time traps, difficulty ratings, and recommended services.

${focusNote}

CRITICAL RULES:
1. Every finding must include laborMinutes — the estimated minutes that condition adds to this job.
2. Time traps (heavy pet hair, smoke or odor saturation, beach sand, mold, glitter, biohazard, vomit) must have category "time_trap" and isTimeTrap: true.
3. Never return a dollar amount. Prices are calculated separately from your output.
4. Use only the service codes listed below. Use "custom" if no code fits.
5. Return ONLY valid JSON — no markdown fences, no code blocks, no explanatory text.

SERVICE CODES (use only these exact strings):
interior_basic, interior_full, interior_deep,
exterior_wash, exterior_wash_wax, exterior_full,
full_detail_basic, full_detail_standard, full_detail_premium,
paint_correction_one, paint_correction_two, paint_correction_three,
ceramic_coat_basic, ceramic_coat_pro,
ppf_partial, ppf_full_front, ppf_full_vehicle,
wheel_clean_full, wheel_refinish, windshield_chip,
pet_hair_removal, odor_treatment, sand_removal,
smoke_treatment, scratch_buff, dent_repair_pdr,
water_spot_removal, paint_decontamination, custom

SEVERITY GUIDE:
- light:    adds fewer than 15 minutes to a base service
- moderate: adds 15–45 minutes
- heavy:    adds 45+ minutes, may require a specialist technique or multiple passes

LABOR REFERENCE (minutes per condition, additive):
Pet hair per seating row: light +10, moderate +35, heavy +75
Sand in carpet: light +10, moderate +25, heavy +45
Smoke saturation: +60–90 (ozone cycle required)
Odor treatment: light +20, moderate +35, heavy +60
Paint scratch per panel: light +10, moderate +30, heavy +60
Water spots on paint: light +10, moderate +25, heavy +45
Swirl marks: light +20, moderate +45, heavy +90
Brake dust on wheels: light +5, moderate +15, heavy +25
Interior full detail base (compact): 90 min — scale up for larger vehicles
Exterior full detail base (compact): 90 min — scale up for larger vehicles

FIELD CONSTRAINTS:
vehicle.size must be one of: compact_car, mid_size_sedan, full_size_sedan, coupe, compact_suv, mid_size_suv, full_size_suv_2row, full_size_suv_3row, minivan, compact_pickup, full_size_pickup_crew, full_size_pickup_regular, sports_car, luxury_sedan, luxury_suv, exotic, cargo_van, convertible, unknown
vehicle.valueTier must be one of: economy, mid-market, premium, luxury, exotic
vehicle.difficultyRating: routine (no time traps, clean vehicle), moderate (some soiling), demanding (multiple conditions), time_trap (at least one time trap present)
finding.category must be one of: time_trap, interior, exterior, glass, wheels, other
finding.severity must be one of: light, moderate, heavy
finding.confidence is a float from 0.0 to 1.0
finding.laborMinutes is an integer from 1 to 480
totalLaborMinutes is the sum of all finding.laborMinutes values

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
      "id": "f1",
      "category": "time_trap",
      "location": "interior_rear_seats",
      "damageType": "pet_hair",
      "severity": "heavy",
      "description": "Dense dog hair covering approximately 80% of rear seat fabric and visible on floor carpet.",
      "serviceCode": "pet_hair_removal",
      "laborMinutes": 75,
      "confidence": 0.91,
      "isTimeTrap": true
    }
  ],
  "totalLaborMinutes": 255,
  "notes": "Notes for the employee, or null if nothing notable."
}`
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Pull estimate info
  const [estimate] = await sql`
    SELECT id, status, service_focus, vehicle_year, vehicle_make, vehicle_model, vehicle_color
    FROM estimates WHERE id = ${estimateId}
  `
  if (!estimate) {
    console.error(`Estimate ${estimateId} not found`)
    process.exit(1)
  }

  // 2. Pull photos
  const photos = await sql`
    SELECT id, role, photo_url, capture_order
    FROM estimate_photos
    WHERE estimate_id = ${estimateId}
    ORDER BY capture_order
  `

  if (photos.length === 0) {
    console.error(`No photos found for estimate ${estimateId}`)
    process.exit(1)
  }

  const focus = serviceFocus ?? estimate.service_focus ?? null

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`ESTIMATE:  ${estimateId}`)
  console.log(`VEHICLE:   ${[estimate.vehicle_year, estimate.vehicle_make, estimate.vehicle_model].filter(Boolean).join(' ') || '(unknown)'}`)
  console.log(`STATUS:    ${estimate.status}`)
  console.log(`FOCUS:     ${focus ?? 'none'}`)
  console.log(`PHOTOS:    ${photos.length} (${photos.map(p => p.role).join(', ')})`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  console.log('Sending to GPT-4o...\n')

  const prompt = buildPrompt(focus)
  const imageBlocks = photos.map(p => ({
    type: 'image_url',
    image_url: { url: p.photo_url, detail: 'high' },
  }))

  const startedAt = Date.now()
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 2048,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: prompt }],
    }],
  })

  const durationMs   = Date.now() - startedAt
  const rawContent   = response.choices[0]?.message?.content ?? ''
  const inputTokens  = response.usage?.prompt_tokens ?? null
  const outputTokens = response.usage?.completion_tokens ?? null
  const model        = response.model

  console.log('━━━━ METADATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`Model:         ${model}`)
  console.log(`Duration:      ${durationMs}ms`)
  console.log(`Input tokens:  ${inputTokens}`)
  console.log(`Output tokens: ${outputTokens}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('━━━━ RAW GPT-4o RESPONSE ━━━━━━━━━━━━━━━━━━━━━━')
  console.log(rawContent)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  // Try to parse and pretty-print it
  try {
    const cleaned = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed  = JSON.parse(cleaned)

    const TARGET = 9_500
    const MARKUP = 2.2
    const findings = parsed.findings ?? []
    const totalMinutes = findings.reduce((s, f) => s + (f.laborMinutes ?? 0), 0)
    const totalCents   = findings.reduce((s, f) => s + Math.round(((f.laborMinutes ?? 0) / 60) * TARGET * MARKUP), 0)

    console.log('━━━━ PARSED SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`Vehicle:        ${parsed.vehicle?.year} ${parsed.vehicle?.make} ${parsed.vehicle?.model} (${parsed.vehicle?.color})`)
    console.log(`Size:           ${parsed.vehicle?.size}`)
    console.log(`Value tier:     ${parsed.vehicle?.valueTier}`)
    console.log(`Difficulty:     ${parsed.vehicle?.difficultyRating}`)
    console.log(`Finding count:  ${findings.length}`)
    console.log(`Time traps:     ${findings.filter(f => f.isTimeTrap).length}`)
    console.log(`Total minutes:  ${totalMinutes}`)
    console.log(`Est. price:     $${(totalCents / 100).toFixed(2)}`)
    console.log(`Notes:          ${parsed.notes ?? 'none'}`)
    console.log('')
    findings.forEach((f, i) => {
      const cents = Math.round(((f.laborMinutes ?? 0) / 60) * TARGET * MARKUP)
      console.log(`[${i+1}] ${f.severity?.toUpperCase()} — ${f.description?.slice(0, 80)}`)
      console.log(`    category=${f.category} | location=${f.location} | code=${f.serviceCode}`)
      console.log(`    labor=${f.laborMinutes}min | price=$${(cents/100).toFixed(2)} | conf=${f.confidence} | timeTrap=${f.isTimeTrap}`)
    })
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  } catch (e) {
    console.log('(Could not parse JSON — raw response above is the full output)')
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
