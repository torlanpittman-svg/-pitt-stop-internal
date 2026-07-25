/**
 * GPT-4o Vision test with on-the-fly image resizing.
 * Pulls photos from DB, resizes to max 1280px via sharp, then runs analysis.
 *
 * Usage: node test-ai-resize.mjs <estimateId>
 */

import OpenAI from 'openai'
import { neon } from '@neondatabase/serverless'
import sharp from 'sharp'

const estimateId = process.argv[2]
if (!estimateId) { console.error('Usage: node test-ai-resize.mjs <estimateId>'); process.exit(1) }
if (!process.env.OPENAI_API_KEY) { console.error('No OPENAI_API_KEY'); process.exit(1) }

const sql    = neon(process.env.DATABASE_URL)
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MAX_SIDE = 1280

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
  "totalLaborMinutes": 255,
  "notes": "Notes for the employee, or null if nothing notable."
}`
}

async function resizeDataUrl(dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
  const buf    = Buffer.from(base64, 'base64')
  const resized = await sharp(buf)
    .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  return `data:image/jpeg;base64,${resized.toString('base64')}`
}

async function main() {
  const [estimate] = await sql`
    SELECT id, status, service_focus, vehicle_year, vehicle_make, vehicle_model
    FROM estimates WHERE id = ${estimateId}
  `
  if (!estimate) { console.error('Estimate not found'); process.exit(1) }

  const photos = await sql`
    SELECT role, photo_url, OCTET_LENGTH(photo_url) as bytes
    FROM estimate_photos WHERE estimate_id = ${estimateId}
    ORDER BY capture_order
  `
  if (photos.length === 0) { console.error('No photos'); process.exit(1) }

  const focus = estimate.service_focus ?? null

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`ESTIMATE:  ${estimateId}`)
  console.log(`VEHICLE:   ${[estimate.vehicle_year, estimate.vehicle_make, estimate.vehicle_model].filter(Boolean).join(' ') || '(unknown)'}`)
  console.log(`FOCUS:     ${focus ?? 'none'}`)
  console.log(`PHOTOS:    ${photos.length} (${photos.map(p => p.role).join(', ')})`)
  console.log('Resizing photos...')

  const resizedUrls = await Promise.all(photos.map(p => resizeDataUrl(p.photo_url)))
  const totalBefore = photos.reduce((s, p) => s + p.bytes, 0)
  const totalAfter  = resizedUrls.reduce((s, u) => s + u.length, 0)
  console.log(`Before: ${(totalBefore/1024/1024).toFixed(1)}MB → After: ${(totalAfter/1024/1024).toFixed(1)}MB`)
  console.log('Sending to GPT-4o...\n')

  const prompt = buildPrompt(focus)
  const imageBlocks = resizedUrls.map(url => ({
    type: 'image_url',
    image_url: { url, detail: 'high' },
  }))

  const startedAt = Date.now()
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 2048,
    temperature: 0,
    messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }],
  })

  const durationMs   = Date.now() - startedAt
  const rawContent   = response.choices[0]?.message?.content ?? ''
  const inputTokens  = response.usage?.prompt_tokens ?? null
  const outputTokens = response.usage?.completion_tokens ?? null

  console.log('━━━━ METADATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`Model:         ${response.model}`)
  console.log(`Duration:      ${durationMs}ms`)
  console.log(`Input tokens:  ${inputTokens}`)
  console.log(`Output tokens: ${outputTokens}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  console.log('━━━━ RAW GPT-4o RESPONSE ━━━━━━━━━━━━━━━━━━━━━━')
  console.log(rawContent)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  try {
    const cleaned = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed  = JSON.parse(cleaned)
    const TARGET = 9_500, MARKUP = 2.2
    const findings = parsed.findings ?? []
    const totalMins  = findings.reduce((s, f) => s + (f.laborMinutes ?? 0), 0)
    const totalCents = findings.reduce((s, f) => s + Math.round(((f.laborMinutes ?? 0)/60)*TARGET*MARKUP), 0)

    console.log('━━━━ PARSED SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`Vehicle:        ${parsed.vehicle?.year} ${parsed.vehicle?.make} ${parsed.vehicle?.model} (${parsed.vehicle?.color})`)
    console.log(`Size:           ${parsed.vehicle?.size}`)
    console.log(`Value tier:     ${parsed.vehicle?.valueTier}`)
    console.log(`Difficulty:     ${parsed.vehicle?.difficultyRating}`)
    console.log(`Finding count:  ${findings.length}`)
    console.log(`Time traps:     ${findings.filter(f => f.isTimeTrap).length}`)
    console.log(`Total minutes:  ${totalMins}`)
    console.log(`Est. price:     $${(totalCents/100).toFixed(2)}`)
    console.log(`Notes:          ${parsed.notes ?? 'none'}`)
    console.log('')
    findings.forEach((f, i) => {
      const cents = Math.round(((f.laborMinutes ?? 0)/60)*TARGET*MARKUP)
      const trap = f.isTimeTrap ? ' ⚠ TIME TRAP' : ''
      console.log(`[${i+1}] severity=${f.severity} | impact=${f.laborImpact} | timeTrap=${f.isTimeTrap}${trap}`)
      console.log(`    ${f.description?.slice(0,90)}`)
      console.log(`    cat=${f.category} | loc=${f.location} | code=${f.serviceCode}`)
      console.log(`    labor=${f.laborMinutes}min | price=$${(cents/100).toFixed(2)} | conf=${f.confidence}`)
    })
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  } catch {
    console.log('(Could not parse JSON)')
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1) })
