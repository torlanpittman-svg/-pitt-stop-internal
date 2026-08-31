import { NextResponse } from 'next/server'
import { validateVIN, normalizeVIN, decodeVINFromNHTSA } from '@/apps/vehicle-entry/vin'
import { employeeAuthorizedFromRequest } from '@/apps/auth/employee-guard'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'

// ── VIN check digit — mirrors transliteration in apps/vehicle-entry/vin.ts ───

const TRANSLITERATION: Record<string, number> = {
  'A':1,'B':2,'C':3,'D':4,'E':5,'F':6,'G':7,'H':8,
  'J':1,'K':2,'L':3,'M':4,'N':5,        'P':7,'R':9,
  'S':2,'T':3,'U':4,'V':5,'W':6,'X':7,'Y':8,'Z':9,
  '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
}
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2]
const VIN_RE  = /^[A-HJ-NPR-Z0-9]{17}$/

function calcCheckDigit(vin: string): string | null {
  if (!VIN_RE.test(vin)) return null
  const sum = vin.split('').reduce((s, c, i) => s + (TRANSLITERATION[c] ?? 0) * WEIGHTS[i], 0)
  const r = sum % 11
  return r === 10 ? 'X' : String(r)
}

function isValidVin(vin: string): boolean {
  const cd = calcCheckDigit(vin)
  return cd !== null && cd === vin[8]
}

// ── Clean chars that cannot appear in a VIN ──────────────────────────────────

function cleanOcrChars(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/I/g, '1')  // I never appears in a VIN
    .replace(/O/g, '0')  // O never appears in a VIN
    .replace(/Q/g, '0')  // Q never appears in a VIN
    .replace(/[^A-HJ-NPR-Z0-9]/g, '')
}

// ── Character substitution table for common OCR confusion pairs ──────────────

const SUBS: Record<string, string[]> = {
  '0': ['D'],
  '1': ['L', '7'],
  '2': ['Z'],
  '5': ['S', 'B'],
  '6': ['G', 'C'],
  '8': ['B'],
  'B': ['8'],
  'C': ['G'],
  'D': ['0'],
  'E': ['F'],
  'F': ['E', 'P'],
  'G': ['6', 'C'],
  'H': ['N'],
  'L': ['1'],
  'N': ['H'],
  'P': ['F'],
  'S': ['5'],
  'U': ['V'],
  'V': ['U'],
  'Z': ['2'],
}

interface VinCandidate {
  vin:        string
  confidence: number
  corrected:  boolean
  note:       string
}

// Given a 17-char string of valid VIN chars, try every single-char repair
// strategy and return all valid results sorted best-first.
function repairVin(raw17: string): VinCandidate[] {
  if (!VIN_RE.test(raw17)) return []

  if (isValidVin(raw17)) {
    return [{ vin: raw17, confidence: 1.0, corrected: false, note: '' }]
  }

  const results: VinCandidate[] = []

  // Pass 1: fix only the check digit (index 8).
  // Handles the common case where OCR misread the check digit character itself.
  const expectedCd = calcCheckDigit(raw17)
  if (expectedCd) {
    const withCd = raw17.slice(0, 8) + expectedCd + raw17.slice(9)
    if (isValidVin(withCd)) {
      results.push({
        vin: withCd,
        confidence: 0.85,
        corrected: true,
        note: `Check digit corrected (position 9: '${raw17[8]}' → '${expectedCd}')`,
      })
    }
  }

  // Pass 2: substitute one non-check-digit character, then recompute check digit.
  // Handles a single misread character anywhere in positions 1–8 or 10–17.
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue
    const alts = SUBS[raw17[i]] ?? []
    for (const alt of alts) {
      const withAlt = raw17.slice(0, i) + alt + raw17.slice(i + 1)
      if (!VIN_RE.test(withAlt)) continue
      const cd = calcCheckDigit(withAlt)
      if (!cd) continue
      const candidate = withAlt.slice(0, 8) + cd + withAlt.slice(9)
      if (!results.some(r => r.vin === candidate)) {
        results.push({
          vin: candidate,
          confidence: 0.70,
          corrected: true,
          note: `Character at position ${i + 1} corrected ('${raw17[i]}' → '${alt}')`,
        })
      }
    }
  }

  // Fallback: return the check-digit-only repair as an unconfirmed best guess.
  if (results.length === 0) {
    const fallback = expectedCd
      ? raw17.slice(0, 8) + expectedCd + raw17.slice(9)
      : raw17
    results.push({
      vin: fallback,
      confidence: 0.40,
      corrected: !!expectedCd,
      note: 'One or more characters may be incorrect — please verify carefully',
    })
  }

  results.sort((a, b) => b.confidence - a.confidence)
  return results
}

// ── GPT-4.1 OCR — returns cleaned candidate strings ─────────────────────────

async function ocrVinCandidates(base64: string, mime: string, client: OpenAI): Promise<string[]> {
  const resp = await client.chat.completions.create({
    model: 'gpt-4.1',
    max_tokens: 300,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' },
        },
        {
          type: 'text',
          text: `You are a VIN extraction specialist for an automotive shop. Find all Vehicle Identification Numbers in this image.

VIN rules:
- Exactly 17 characters: uppercase A-Z (EXCEPT I, O, Q) and digits 0-9
- The letters I, O, Q NEVER appear in a valid VIN — substitute: I→1, O→0, Q→0
- May appear on a barcode label, door-jamb sticker, dashboard plate, or stamped metal
- The image may be rotated — read text in all orientations

Common OCR mistakes to watch for and pre-correct:
- '0' vs 'D' or 'O' → use '0' or 'D', never 'O'
- '1' vs 'I' or 'L' → use '1', never 'I'
- '2' vs 'Z'
- '5' vs 'S'
- '6' vs 'G'
- '8' vs 'B'
- 'U' vs 'V'

Return ONLY this JSON (no other text):
{"candidates": ["17CHARVIN1234567", "ALTERNATE17CHAR1"]}

List up to 3 candidates, best confidence first. If no 17-character sequence is found, return: {"candidates": []}`,
        },
      ],
    }],
  })

  const content = (resp.choices[0]?.message?.content ?? '').trim()
  try {
    const parsed = JSON.parse(content.replace(/```json\n?|```/g, '').trim()) as { candidates?: unknown[] }
    return (parsed.candidates ?? [])
      .filter((s): s is string => typeof s === 'string')
      .map(s => cleanOcrChars(s))
      .filter(s => s.length >= 17)
      .slice(0, 5)
  } catch {
    // Fallback: pull any 17+ char run from the response
    const runs = content.match(/[A-HJ-NPR-Z0-9]{17,}/g) ?? []
    return runs.map(r => cleanOcrChars(r)).filter(s => s.length >= 17)
  }
}

// ── Main image processing pipeline ──────────────────────────────────────────

async function processVinImage(image: File, client: OpenAI) {
  const bytes  = await image.arrayBuffer()
  const base64 = Buffer.from(bytes).toString('base64')
  const mime   = image.type || 'image/jpeg'

  // 1. OCR pass
  const rawCandidates = await ocrVinCandidates(base64, mime, client)
  if (rawCandidates.length === 0) return null

  // 2. Slide a 17-char window over each result, attempt repair on each window
  const allCandidates: VinCandidate[] = []
  for (const raw of rawCandidates) {
    for (let start = 0; start <= raw.length - 17; start++) {
      const win = raw.slice(start, start + 17)
      if (VIN_RE.test(win)) allCandidates.push(...repairVin(win))
    }
  }

  if (allCandidates.length === 0) return null

  // 3. Deduplicate and sort by confidence
  const seen   = new Set<string>()
  const unique = allCandidates.filter(c => seen.has(c.vin) ? false : (seen.add(c.vin), true))
  unique.sort((a, b) => b.confidence - a.confidence)

  // 4. Try NHTSA on top candidates — prefer one that decodes to a real vehicle
  for (const cand of unique.slice(0, 3)) {
    try {
      const decoded = await decodeVINFromNHTSA(cand.vin)
      if (decoded.make && decoded.year) {
        return {
          vin:       cand.vin,
          confirmed: !cand.corrected,
          note:      cand.note || null,
          year:      decoded.year,
          make:      decoded.make,
          model:     decoded.model,
          bodyClass: decoded.bodyClass,
        }
      }
    } catch { /* try next */ }
  }

  // 5. Return best candidate without NHTSA data
  const best = unique[0]
  return {
    vin:       best.vin,
    confirmed: !best.corrected,
    note:      best.note || null,
    year:      null as string | null,
    make:      null as string | null,
    model:     null as string | null,
    bodyClass: null as string | null,
  }
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    // Defense-in-depth (proxy.ts is the primary gate): never run VIN OCR/AI for an unauthenticated caller.
    if (!(await employeeAuthorizedFromRequest(request))) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
    }
    const contentType = request.headers.get('content-type') ?? ''

    // ── Image OCR path ────────────────────────────────────────────────────────
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const image    = formData.get('vinImage') as File | null
      if (!image) return NextResponse.json({ error: 'No image provided' }, { status: 400 })

      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 })

      const client = new OpenAI({ apiKey })

      let result: Awaited<ReturnType<typeof processVinImage>>
      try {
        result = await processVinImage(image, client)
      } catch {
        return NextResponse.json(
          { error: 'Could not read VIN from photo — try better lighting or type the VIN manually' },
          { status: 422 },
        )
      }

      if (!result) {
        return NextResponse.json(
          { error: 'No VIN found in photo — aim at the barcode or printed VIN and try again' },
          { status: 422 },
        )
      }

      return NextResponse.json(result)
    }

    // ── Text VIN path ─────────────────────────────────────────────────────────
    const body = await request.json() as { vin?: string }
    if (!body.vin) return NextResponse.json({ error: 'Missing vin' }, { status: 400 })

    const { valid, error } = validateVIN(body.vin)
    if (!valid) return NextResponse.json({ error }, { status: 422 })

    const vin     = normalizeVIN(body.vin)
    const decoded = await decodeVINFromNHTSA(vin)
    return NextResponse.json({
      vin:       decoded.vin,
      year:      decoded.year,
      make:      decoded.make,
      model:     decoded.model,
      bodyClass: decoded.bodyClass,
      confirmed: true,
    })

  } catch {
    return NextResponse.json(
      { error: 'VIN lookup unavailable — enter vehicle details manually' },
      { status: 502 },
    )
  }
}
