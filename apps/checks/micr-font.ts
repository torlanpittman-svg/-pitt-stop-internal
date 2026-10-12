/**
 * The E-13B MICR font used on negotiable checks: GnuMICR 0.30 (GPL v2), the UNMODIFIED Type 1 font kept
 * with its license + source under apps/checks/fonts/gnumicr/ (see NOTICE.md there). SERVER-ONLY.
 *
 * It is read from disk at print time and embedded in the check PDF as a Type 1 FontFile (PDF supports
 * Type 1 natively — no conversion, so the author's hand-built outlines are used as-is).
 *
 * GEOMETRY (verified against the font file by micr-font.test.ts): the font is built on the E-13B 0.013"
 * module grid at its 12 pt design size —
 *   advance 751 units → 0.1252"  (8 characters per inch)
 *   height  702 units → 0.1170"  (E-13B character height)
 *   every glyph's right edge sits at x = 649 (E-13B characters are RIGHT-aligned in their position)
 * so it MUST be printed at exactly 12 pt; any other size breaks the character dimensions.
 *
 * ENCODING: digits at '0'–'9'; the four symbols at  A = Transit ⑆,  B = Amount ⑇,  C = On-Us ⑈,  D = Dash ⑉.
 *
 * FAIL CLOSED: if the font file is missing/unreadable/altered, loadMicrFont() returns null and no
 * negotiable MICR line is ever rendered.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const MICR_FONT = {
  name: 'GnuMICR',
  designSizePt: 12,
  unitsPerEm: 1000,
  advance: 751,                 // every glyph
  glyphRight: 649,              // xMax of every glyph (right-aligned characters)
  height: 702,                  // digit / transit / amount symbol height
  stemV: 78,                    // one E-13B module (0.013" at 12 pt)
  bbox: [10, 0, 720, 702] as const,
  firstChar: 32,
  lastChar: 68,
  sha256: 'd35285bc392e9843806d103d872ebc68182adade82e18d7ab1d33836886c9c45', // GnuMICR.pfb, v0.30
  /** Font character code per E-13B symbol. */
  glyph: { transit: 'A', amount: 'B', onUs: 'C', dash: 'D' } as const,
} as const

/** Characters the font can render in a MICR position. */
export const MICR_FONT_CHARS = '0123456789ABCD'

export interface MicrFontData {
  /** Type 1 program split into the three PFB sections PDF needs (cleartext / encrypted / trailer). */
  clear: Buffer; encrypted: Buffer; trailer: Buffer
}

const FONT_FILE = join('apps', 'checks', 'fonts', 'gnumicr', 'GnuMICR.pfb')

/** Split a .pfb into its ASCII (type 1) and binary (type 2) segments. Throws on a malformed file. */
export function parsePfb(pfb: Buffer): MicrFontData {
  const segs: { type: number; data: Buffer }[] = []
  let i = 0
  while (i < pfb.length) {
    if (pfb[i] !== 0x80) throw new Error('not a PFB file (bad segment marker)')
    const type = pfb[i + 1]
    if (type === 3) break
    const len = pfb.readUInt32LE(i + 2)
    segs.push({ type, data: pfb.subarray(i + 6, i + 6 + len) })
    i += 6 + len
  }
  if (segs.length !== 3 || segs[0].type !== 1 || segs[1].type !== 2 || segs[2].type !== 1) {
    throw new Error('unexpected PFB structure (want cleartext, encrypted, trailer)')
  }
  return { clear: segs[0].data, encrypted: segs[1].data, trailer: segs[2].data }
}

let cache: MicrFontData | null | undefined

/**
 * Load + verify the bundled E-13B font. Returns null when it cannot be read, is not the expected file
 * (sha256 pinned, so a swapped/corrupted font can never silently print a MICR line), or is malformed.
 */
export function loadMicrFont(): MicrFontData | null {
  if (cache !== undefined) return cache
  try {
    const pfb = readFileSync(join(process.cwd(), FONT_FILE))
    if (createHash('sha256').update(pfb).digest('hex') !== MICR_FONT.sha256) throw new Error('font checksum mismatch')
    cache = parsePfb(pfb)
  } catch {
    cache = null
  }
  return cache
}

/** True when the E-13B font is present, intact, and embeddable. */
export function micrFontAvailable(): boolean {
  return loadMicrFont() !== null
}

/** Test seam: forget the cached load result. */
export function resetMicrFontCache(): void { cache = undefined }
