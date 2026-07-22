/**
 * VIN utilities — validation, stock number construction, NHTSA decode.
 * Pure functions safe to import in both client and server code.
 * decodeVINFromNHTSA is server-side only (call via /api/vehicle-entry/vin).
 */

// FMVSS 49 CFR 565 transliteration table (I, O, Q are excluded from VINs)
const TRANSLITERATION: Record<string, number> = {
  'A':1,'B':2,'C':3,'D':4,'E':5,'F':6,'G':7,'H':8,
  'J':1,'K':2,'L':3,'M':4,'N':5,        'P':7,'R':9,
  'S':2,'T':3,'U':4,'V':5,'W':6,'X':7,'Y':8,'Z':9,
  '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
}

const POSITION_WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2]

export function normalizeVIN(raw: string): string {
  return raw.replace(/\s/g, '').toUpperCase()
}

export function validateVIN(raw: string): { valid: boolean; error?: string } {
  const v = normalizeVIN(raw)
  if (v.length !== 17) {
    return { valid: false, error: `VIN must be 17 characters (got ${v.length})` }
  }
  if (/[IOQ]/.test(v)) {
    return { valid: false, error: 'VIN cannot contain the letters I, O, or Q' }
  }

  let sum = 0
  for (let i = 0; i < 17; i++) {
    const val = TRANSLITERATION[v[i]]
    if (val === undefined) {
      return { valid: false, error: `Invalid character '${v[i]}' at position ${i + 1}` }
    }
    sum += val * POSITION_WEIGHTS[i]
  }

  const remainder = sum % 11
  const expected  = remainder === 10 ? 'X' : String(remainder)
  if (v[8] !== expected) {
    return { valid: false, error: 'Check digit mismatch — verify each character carefully' }
  }

  return { valid: true }
}

export function buildStockNumber(prefix: string, vin: string): string {
  return prefix + normalizeVIN(vin).slice(-6)
}

export interface VINDecodeResult {
  vin:       string
  year:      string | null
  make:      string | null
  model:     string | null
  bodyClass: string | null
}

// ── Server-side only ────────────────────────────────────────────────────────

const MAKE_NORMALIZE: Record<string, string> = {
  'HONDA': 'Honda', 'TOYOTA': 'Toyota', 'FORD': 'Ford',
  'CHEVROLET': 'Chevrolet', 'CHEVY': 'Chevrolet', 'GMC': 'GMC',
  'DODGE': 'Dodge', 'RAM': 'Ram', 'CHRYSLER': 'Chrysler', 'JEEP': 'Jeep',
  'NISSAN': 'Nissan', 'HYUNDAI': 'Hyundai', 'KIA': 'Kia',
  'SUBARU': 'Subaru', 'MAZDA': 'Mazda', 'MITSUBISHI': 'Mitsubishi',
  'BMW': 'BMW', 'MERCEDES-BENZ': 'Mercedes-Benz', 'VOLKSWAGEN': 'Volkswagen',
  'AUDI': 'Audi', 'VOLVO': 'Volvo', 'LEXUS': 'Lexus', 'ACURA': 'Acura',
  'INFINITI': 'Infiniti', 'LINCOLN': 'Lincoln', 'BUICK': 'Buick',
  'CADILLAC': 'Cadillac', 'LAND ROVER': 'Land Rover', 'PORSCHE': 'Porsche',
  'MINI': 'MINI',
}

function cleanField(s: string | undefined): string | null {
  if (!s) return null
  const t = s.trim()
  return t === '' || t === 'Not Applicable' || t === '0' ? null : t
}

function normalizeMake(raw: string): string {
  return MAKE_NORMALIZE[raw.toUpperCase().trim()] ??
    raw.toLowerCase().replace(/(?:^|\s|-)\S/g, c => c.toUpperCase())
}

export async function decodeVINFromNHTSA(vin: string): Promise<VINDecodeResult> {
  const v   = normalizeVIN(vin)
  const res = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${v}?format=json`,
    { signal: AbortSignal.timeout(10_000) }
  )
  if (!res.ok) throw new Error(`NHTSA returned ${res.status}`)

  const data   = await res.json() as { Results?: Array<Record<string, string>> }
  const result = data.Results?.[0] ?? {}

  const rawMake = cleanField(result['Make'])
  const model   = cleanField(result['Model'])

  return {
    vin:       v,
    year:      cleanField(result['ModelYear']),
    make:      rawMake ? normalizeMake(rawMake) : null,
    model,
    bodyClass: cleanField(result['BodyClass']),
  }
}
