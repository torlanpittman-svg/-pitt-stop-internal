export type VehicleType = 'coupe' | 'sedan' | 'suv' | 'truck' | 'van' | 'unknown'

export type VehicleLayout = {
  type:         VehicleType
  hasRearSeats: boolean  // meaningful rear seating (not just a token back seat)
  hasThirdRow:  boolean
  hasTruckBed:  boolean
  hasCargoArea: boolean  // open cargo zone behind last row (SUV/van)
  hasTrunk:     boolean  // enclosed trunk (sedan/coupe)
}

export type LayoutQuestion = {
  key:  'hasRearSeats' | 'hasThirdRow'
  text: string
}

export type LayoutInference = {
  layout:    VehicleLayout
  questions: LayoutQuestion[]  // empty when layout is unambiguous
}

// 'yes' = always present, 'no' = never present, 'ask' = depends on trim/config
type RowConfig = 'yes' | 'no' | 'ask'

type ModelProfile = {
  forceType?: VehicleType  // override body-class detection for misclassified vehicles
  thirdRow?:  RowConfig    // third-row config for SUVs/vans
  rearSeat?:  RowConfig    // rear-seat config for trucks
}

// ── Name normalization ─────────────────────────────────────────────────────

const MAKE_ALIASES: Record<string, string> = {
  chevy:    'chevrolet',
  vw:       'volkswagen',
  mercedes: 'mercedes-benz',
  merc:     'mercedes-benz',
}

function norm(s: string | null): string {
  if (!s) return ''
  const lower = s.toLowerCase().trim().replace(/\s+/g, ' ')
  return MAKE_ALIASES[lower] ?? lower
}

// ── Vehicle knowledge table ────────────────────────────────────────────────
// Key: "{make} {model}" (normalized lowercase, single spaces).
// Body-class detection alone is insufficient for most SUVs (can't tell 2-row
// from 3-row) and for hatchbacks/subcompacts that VIN databases sometimes
// mis-tag. Profile takes priority over body-class detection.

const MODEL_PROFILES: Record<string, ModelProfile> = {

  // ══════════════════════════════════════════════════════════════════════════
  // SUVs / Crossovers — ALWAYS 3 rows
  // ══════════════════════════════════════════════════════════════════════════
  'chevrolet suburban':           { thirdRow: 'yes' },
  'chevrolet tahoe':              { thirdRow: 'yes' },
  'chevrolet traverse':           { thirdRow: 'yes' },
  'cadillac escalade':            { thirdRow: 'yes' },
  'cadillac escalade esv':        { thirdRow: 'yes' },
  'gmc yukon':                    { thirdRow: 'yes' },
  'gmc yukon xl':                 { thirdRow: 'yes' },
  'gmc acadia':                   { thirdRow: 'yes' },
  'buick enclave':                { thirdRow: 'yes' },
  'ford expedition':              { thirdRow: 'yes' },
  'ford expedition max':          { thirdRow: 'yes' },
  'ford flex':                    { thirdRow: 'yes' },
  'lincoln navigator':            { thirdRow: 'yes' },
  'lincoln navigator l':          { thirdRow: 'yes' },
  'toyota sequoia':               { thirdRow: 'yes' },
  'toyota highlander':            { thirdRow: 'yes' },
  'toyota land cruiser':          { thirdRow: 'yes' },
  'toyota sienna':                { thirdRow: 'yes' },
  'honda pilot':                  { thirdRow: 'yes' },
  'honda odyssey':                { thirdRow: 'yes' },
  'acura mdx':                    { thirdRow: 'yes' },
  'kia telluride':                { thirdRow: 'yes' },
  'kia carnival':                 { thirdRow: 'yes' },
  'kia sedona':                   { thirdRow: 'yes' },
  'hyundai palisade':             { thirdRow: 'yes' },
  'mazda cx-9':                   { thirdRow: 'yes' },
  'mazda cx-90':                  { thirdRow: 'yes' },
  'subaru ascent':                { thirdRow: 'yes' },
  'volkswagen atlas':             { thirdRow: 'yes' },
  'nissan pathfinder':            { thirdRow: 'yes' },
  'nissan armada':                { thirdRow: 'yes' },
  'dodge durango':                { thirdRow: 'yes' },
  'chrysler pacifica':            { thirdRow: 'yes' },
  'chrysler town and country':    { thirdRow: 'yes' },
  'chrysler town & country':      { thirdRow: 'yes' },
  'chrysler voyager':             { thirdRow: 'yes' },
  'dodge grand caravan':          { thirdRow: 'yes' },
  'dodge caravan':                { thirdRow: 'yes' },
  'jeep grand cherokee l':        { thirdRow: 'yes' },
  'jeep wagoneer':                { thirdRow: 'yes' },
  'jeep grand wagoneer':          { thirdRow: 'yes' },
  'land rover discovery':         { thirdRow: 'yes' },
  'volvo xc90':                   { thirdRow: 'yes' },
  'lexus lx':                     { thirdRow: 'yes' },
  'lexus lx 570':                 { thirdRow: 'yes' },
  'lexus lx 600':                 { thirdRow: 'yes' },
  'infiniti qx60':                { thirdRow: 'yes' },
  'infiniti qx80':                { thirdRow: 'yes' },
  'mercedes-benz gls':            { thirdRow: 'yes' },
  'mercedes gls':                 { thirdRow: 'yes' },
  'mercedes-benz glb':            { thirdRow: 'yes' },
  'mercedes glb':                 { thirdRow: 'yes' },
  'bmw x7':                       { thirdRow: 'yes' },
  'tesla model x':                { thirdRow: 'yes' },
  'rivian r1s':                   { thirdRow: 'yes' },

  // ══════════════════════════════════════════════════════════════════════════
  // SUVs / Crossovers — NEVER 3 rows
  // ══════════════════════════════════════════════════════════════════════════
  'honda cr-v':                   { thirdRow: 'no' },
  'honda hr-v':                   { thirdRow: 'no' },
  'honda hrv':                    { thirdRow: 'no' },
  'honda passport':               { thirdRow: 'no' },
  'honda element':                { thirdRow: 'no' },
  'toyota rav4':                  { thirdRow: 'no' },
  'toyota corolla cross':         { thirdRow: 'no' },
  'toyota venza':                 { thirdRow: 'no' },
  'toyota c-hr':                  { thirdRow: 'no' },
  'toyota 4runner':               { thirdRow: 'no' },
  'toyota fj cruiser':            { thirdRow: 'no' },
  'mazda cx-5':                   { thirdRow: 'no' },
  'mazda cx5':                    { thirdRow: 'no' },
  'mazda cx-30':                  { thirdRow: 'no' },
  'mazda cx-3':                   { thirdRow: 'no' },
  'mazda cx-50':                  { thirdRow: 'no' },
  'subaru forester':              { thirdRow: 'no' },
  'subaru outback':               { thirdRow: 'no' },
  'subaru crosstrek':             { thirdRow: 'no' },
  'subaru baja':                  { thirdRow: 'no' },
  'jeep cherokee':                { thirdRow: 'no' },
  'jeep grand cherokee':          { thirdRow: 'no' },
  'jeep wrangler':                { thirdRow: 'no' },
  'jeep compass':                 { thirdRow: 'no' },
  'jeep renegade':                { thirdRow: 'no' },
  'jeep patriot':                 { thirdRow: 'no' },
  'ford escape':                  { thirdRow: 'no' },
  'ford bronco':                  { thirdRow: 'no' },
  'ford bronco sport':            { thirdRow: 'no' },
  'ford edge':                    { thirdRow: 'no' },
  'ford ecosport':                { thirdRow: 'no' },
  'hyundai tucson':               { thirdRow: 'no' },
  'hyundai santa fe':             { thirdRow: 'no' },
  'hyundai kona':                 { thirdRow: 'no' },
  'hyundai venue':                { thirdRow: 'no' },
  'hyundai ioniq 5':              { thirdRow: 'no' },
  'hyundai ioniq 6':              { thirdRow: 'no' },
  'kia sportage':                 { thirdRow: 'no' },
  'kia sorento':                  { thirdRow: 'no' },
  'kia seltos':                   { thirdRow: 'no' },
  'kia soul':                     { thirdRow: 'no' },
  'kia niro':                     { thirdRow: 'no' },
  'kia ev6':                      { thirdRow: 'no' },
  'kia stinger':                  { thirdRow: 'no' },
  'nissan rogue':                 { thirdRow: 'no' },
  'nissan kicks':                 { thirdRow: 'no' },
  'nissan murano':                { thirdRow: 'no' },
  'nissan juke':                  { thirdRow: 'no' },
  'chevrolet equinox':            { thirdRow: 'no' },
  'chevrolet trax':               { thirdRow: 'no' },
  'chevrolet trailblazer':        { thirdRow: 'no' },
  'chevrolet blazer':             { thirdRow: 'no' },
  'gmc terrain':                  { thirdRow: 'no' },
  'gmc envoy':                    { thirdRow: 'no' },
  'bmw x1':                       { thirdRow: 'no' },
  'bmw x2':                       { thirdRow: 'no' },
  'bmw x3':                       { thirdRow: 'no' },
  'bmw x4':                       { thirdRow: 'no' },
  'bmw x5':                       { thirdRow: 'no' },
  'bmw x6':                       { thirdRow: 'no' },
  'mercedes-benz gle':            { thirdRow: 'no' },
  'mercedes gle':                 { thirdRow: 'no' },
  'mercedes-benz glc':            { thirdRow: 'no' },
  'mercedes glc':                 { thirdRow: 'no' },
  'mercedes-benz gla':            { thirdRow: 'no' },
  'mercedes gla':                 { thirdRow: 'no' },
  'mercedes-benz glk':            { thirdRow: 'no' },
  'mercedes glk':                 { thirdRow: 'no' },
  'audi q3':                      { thirdRow: 'no' },
  'audi q5':                      { thirdRow: 'no' },
  'audi q8':                      { thirdRow: 'no' },
  'audi q4':                      { thirdRow: 'no' },
  'audi q4 e-tron':               { thirdRow: 'no' },
  'volvo xc40':                   { thirdRow: 'no' },
  'volvo xc60':                   { thirdRow: 'no' },
  'land rover range rover':       { thirdRow: 'no' },
  'land rover range rover sport': { thirdRow: 'no' },
  'land rover range rover evoque':{ thirdRow: 'no' },
  'land rover range rover velar': { thirdRow: 'no' },
  'land rover discovery sport':   { thirdRow: 'no' },
  'land rover freelander':        { thirdRow: 'no' },
  'lexus rx':                     { thirdRow: 'no' },
  'lexus rx 350':                 { thirdRow: 'no' },
  'lexus rx 450h':                { thirdRow: 'no' },
  'lexus gx':                     { thirdRow: 'no' },
  'lexus gx 460':                 { thirdRow: 'no' },
  'lexus nx':                     { thirdRow: 'no' },
  'lexus ux':                     { thirdRow: 'no' },
  'lexus is':                     { thirdRow: 'no' },
  'lexus es':                     { thirdRow: 'no' },
  'acura rdx':                    { thirdRow: 'no' },
  'infiniti qx50':                { thirdRow: 'no' },
  'infiniti qx55':                { thirdRow: 'no' },
  'tesla model 3':                { thirdRow: 'no' },
  'tesla model s':                { thirdRow: 'no' },
  'volkswagen atlas cross sport': { thirdRow: 'no' },

  // ══════════════════════════════════════════════════════════════════════════
  // SUVs — genuinely ambiguous (ask employee)
  // ══════════════════════════════════════════════════════════════════════════
  'ford explorer':                { thirdRow: 'ask' },
  'audi q7':                      { thirdRow: 'ask' },
  'dodge journey':                { thirdRow: 'ask' },
  'tesla model y':                { thirdRow: 'ask' },  // 5-seat and 7-seat trims

  // ══════════════════════════════════════════════════════════════════════════
  // Hatchbacks and small cars that NHTSA sometimes misclassifies
  // ══════════════════════════════════════════════════════════════════════════
  'scion xb':                     { forceType: 'sedan', thirdRow: 'no' },
  'scion xa':                     { forceType: 'sedan', thirdRow: 'no' },
  'scion tc':                     { forceType: 'sedan', thirdRow: 'no' },
  'scion im':                     { forceType: 'sedan', thirdRow: 'no' },
  'scion ia':                     { forceType: 'sedan', thirdRow: 'no' },
  'scion iq':                     { forceType: 'sedan', thirdRow: 'no' },
  'scion fr-s':                   { forceType: 'sedan', thirdRow: 'no' },

  // ══════════════════════════════════════════════════════════════════════════
  // Trucks — always crew cab (rear seats always present)
  // ══════════════════════════════════════════════════════════════════════════
  'honda ridgeline':              { rearSeat: 'yes' },
  'hyundai santa cruz':           { rearSeat: 'yes' },
  'ford maverick':                { rearSeat: 'yes' },
  'rivian r1t':                   { rearSeat: 'yes' },
  'jeep gladiator':               { rearSeat: 'yes' },

  // ══════════════════════════════════════════════════════════════════════════
  // Trucks — cab config varies (ask employee)
  // Body class already tells us it's a truck; we just need the cab question.
  // ══════════════════════════════════════════════════════════════════════════
  'ford f-150':                   { rearSeat: 'ask' },
  'ford f150':                    { rearSeat: 'ask' },
  'ford f-250':                   { rearSeat: 'ask' },
  'ford f-350':                   { rearSeat: 'ask' },
  'ford f-450':                   { rearSeat: 'ask' },
  'ford ranger':                  { rearSeat: 'ask' },
  'chevrolet silverado':          { rearSeat: 'ask' },
  'chevrolet silverado 1500':     { rearSeat: 'ask' },
  'chevrolet colorado':           { rearSeat: 'ask' },
  'chevrolet s-10':               { rearSeat: 'ask' },
  'chevrolet s10':                { rearSeat: 'ask' },
  'gmc sierra':                   { rearSeat: 'ask' },
  'gmc sierra 1500':              { rearSeat: 'ask' },
  'gmc canyon':                   { rearSeat: 'ask' },
  'toyota tacoma':                { rearSeat: 'ask' },
  'toyota tundra':                { rearSeat: 'ask' },
  'toyota hilux':                 { rearSeat: 'ask' },
  'ram 1500':                     { rearSeat: 'ask' },
  'ram 2500':                     { rearSeat: 'ask' },
  'ram 3500':                     { rearSeat: 'ask' },
  'dodge ram':                    { rearSeat: 'ask' },
  'dodge ram 1500':               { rearSeat: 'ask' },
  'nissan frontier':              { rearSeat: 'ask' },
  'nissan titan':                 { rearSeat: 'ask' },
}

// ── Profile lookup ─────────────────────────────────────────────────────────

function lookupProfile(make: string | null, model: string | null): ModelProfile | null {
  const key = `${norm(make)} ${norm(model)}`.trim()
  if (MODEL_PROFILES[key]) return MODEL_PROFILES[key]
  return null
}

// ── Body-class type detection ──────────────────────────────────────────────

function detectTypeFromBodyClass(bodyClass: string | null): VehicleType {
  if (!bodyClass) return 'unknown'
  const bc = bodyClass.toLowerCase()
  if (bc.includes('pickup')) return 'truck'
  if (bc.includes('minivan') || bc.includes('mini-van')) return 'van'
  if (bc.includes('van')) return 'van'
  if (bc.includes('sport utility') || bc.includes('suv') ||
      bc.includes('multi-purpose vehicle') || bc.includes('crossover')) return 'suv'
  if (bc.includes('coupe') || bc.includes('convertible') || bc.includes('cabriolet')) return 'coupe'
  if (bc.includes('sedan') || bc.includes('saloon') || bc.includes('hatchback') ||
      bc.includes('liftback') || bc.includes('notchback') ||
      bc.includes('wagon') || bc.includes('estate')) return 'sedan'
  return 'unknown'
}

// ── Public API ─────────────────────────────────────────────────────────────

export function detectLayout(params: {
  bodyClass: string | null
  make:      string | null
  model:     string | null
}): LayoutInference {
  const profile = lookupProfile(params.make, params.model)

  // Profile can force a type (for misclassified vehicles); otherwise use body class
  const type = profile?.forceType ?? detectTypeFromBodyClass(params.bodyClass)

  const questions: LayoutQuestion[] = []
  let layout: VehicleLayout

  switch (type) {
    case 'coupe':
      layout = { type, hasRearSeats: false, hasThirdRow: false, hasTruckBed: false, hasCargoArea: false, hasTrunk: true }
      break

    case 'sedan':
      layout = { type, hasRearSeats: true, hasThirdRow: false, hasTruckBed: false, hasCargoArea: false, hasTrunk: true }
      break

    case 'suv': {
      const cfg = profile?.thirdRow ?? 'ask'
      layout = { type, hasRearSeats: true, hasThirdRow: cfg === 'yes', hasTruckBed: false, hasCargoArea: true, hasTrunk: false }
      if (cfg === 'ask') questions.push({ key: 'hasThirdRow', text: 'Does this vehicle have a third row?' })
      break
    }

    case 'truck': {
      const cfg = profile?.rearSeat ?? 'ask'
      layout = { type, hasRearSeats: cfg === 'yes', hasThirdRow: false, hasTruckBed: true, hasCargoArea: false, hasTrunk: false }
      if (cfg === 'ask') questions.push({ key: 'hasRearSeats', text: 'Does this truck have a rear seat?' })
      break
    }

    case 'van':
      layout = { type, hasRearSeats: true, hasThirdRow: true, hasTruckBed: false, hasCargoArea: true, hasTrunk: false }
      break

    default: { // 'unknown'
      const cfg = profile?.thirdRow ?? 'ask'
      layout = { type: 'unknown', hasRearSeats: true, hasThirdRow: cfg === 'yes', hasTruckBed: false, hasCargoArea: false, hasTrunk: true }
      if (cfg === 'ask') questions.push({ key: 'hasThirdRow', text: 'Does this vehicle have a third row?' })
      break
    }
  }

  return { layout, questions }
}

export function applyLayoutAnswers(
  layout:  VehicleLayout,
  answers: Partial<Record<LayoutQuestion['key'], boolean>>
): VehicleLayout {
  return { ...layout, ...answers }
}
